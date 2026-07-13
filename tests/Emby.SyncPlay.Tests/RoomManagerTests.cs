using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Emby.SyncPlay.Core;
using Xunit;

namespace Emby.SyncPlay.Tests
{
    public sealed class RoomManagerTests
    {
        [Fact]
        public void CreateRoom_BindsMediaAndCreator()
        {
            var fixture = new Fixture();
            var result = fixture.Manager.CreateRoom(
                fixture.Host,
                42,
                "Episode 1",
                TimeSpan.FromSeconds(12).Ticks,
                false,
                "Friday Night");

            Assert.Matches("^[0-9]{3}$", result.Room.Code);
            Assert.Equal(42, result.Room.ItemId);
            Assert.Equal("Friday Night", result.Room.Name);
            Assert.True(result.Room.IsCreator);
            Assert.Equal("Playing", result.Room.State);
            Assert.Single(result.Room.Members);
            Assert.False(string.IsNullOrWhiteSpace(result.MemberToken));
        }

        [Fact]
        public void CreateRooms_GeneratesUniqueThreeDigitNumericCodes()
        {
            var fixture = new Fixture();
            var codes = new HashSet<string>(StringComparer.Ordinal);

            for (var index = 0; index < 100; index++)
            {
                var session = new SessionDescriptor
                {
                    SessionId = "host-" + index,
                    UserId = index.ToString(),
                    UserName = "Host " + index,
                    DeviceName = "Test"
                };
                var result = fixture.Manager.CreateRoom(session, 42, "Episode 1", 0, true, null);

                Assert.Matches("^[0-9]{3}$", result.Room.Code);
                Assert.True(codes.Add(result.Room.Code), "Room codes must be unique while rooms are active.");
            }
        }

        [Fact]
        public async Task CreateRooms_AllocatesUniqueCodesUnderConcurrency()
        {
            var fixture = new Fixture();
            var tasks = Enumerable.Range(0, 50).Select(index => Task.Run(() =>
                fixture.Manager.CreateRoom(
                    new SessionDescriptor
                    {
                        SessionId = "concurrent-host-" + index,
                        UserId = index.ToString(),
                        UserName = "Concurrent Host " + index,
                        DeviceName = "Test"
                    },
                    42,
                    "Episode 1",
                    0,
                    true,
                    null)));

            var rooms = await Task.WhenAll(tasks);
            Assert.Equal(50, rooms.Select(result => result.Room.Code).Distinct(StringComparer.Ordinal).Count());
            Assert.All(rooms, result => Assert.Matches("^[0-9]{3}$", result.Room.Code));
        }

        [Fact]
        public async Task JoinRoom_RejectsCodesOutsideThreeDigitRule()
        {
            var fixture = new Fixture();
            fixture.CreateRoom();

            await Assert.ThrowsAsync<KeyNotFoundException>(() =>
                fixture.Manager.JoinRoomAsync("1A4", fixture.Guest, CancellationToken.None));
            await Assert.ThrowsAsync<KeyNotFoundException>(() =>
                fixture.Manager.JoinRoomAsync("12", fixture.Guest, CancellationToken.None));
            await Assert.ThrowsAsync<KeyNotFoundException>(() =>
                fixture.Manager.JoinRoomAsync("1234", fixture.Guest, CancellationToken.None));
        }

        [Fact]
        public async Task JoinRoom_SendsLoadAtEstimatedPosition()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            fixture.Clock.Advance(TimeSpan.FromSeconds(3));

            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            var load = fixture.Sink.Commands
                .Where(command => command.SessionId == fixture.Guest.SessionId)
                .Select(command => command.Data)
                .OfType<SyncPlayCommand>()
                .First(command => command.Kind == "Load");

            Assert.Equal(2, joined.Room.MemberCount);
            Assert.InRange(load.PositionTicks, TimeSpan.FromSeconds(14.9).Ticks, TimeSpan.FromSeconds(15.1).Ticks);
        }

        [Fact]
        public async Task Control_RejectsOutOfOrderSequenceAndBroadcastsLatest()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Sink.Commands.Clear();

            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayControl", new SyncPlaySocketEnvelope
            {
                MemberToken = created.MemberToken,
                ClientSequence = 2,
                EventId = "latest",
                Kind = "Pause",
                PositionTicks = TimeSpan.FromSeconds(20).Ticks,
                IsPaused = true
            }, CancellationToken.None);
            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayControl", new SyncPlaySocketEnvelope
            {
                MemberToken = created.MemberToken,
                ClientSequence = 1,
                EventId = "stale",
                Kind = "Play",
                PositionTicks = TimeSpan.FromSeconds(2).Ticks,
                IsPaused = false
            }, CancellationToken.None);

            var commands = fixture.Sink.Commands
                .Where(command => command.SessionId == fixture.Guest.SessionId)
                .Select(command => command.Data)
                .OfType<SyncPlayCommand>()
                .ToList();
            Assert.Single(commands);
            Assert.Equal("Pause", commands[0].Kind);
            Assert.Equal("latest", commands[0].EventId);
            Assert.Equal("Paused", fixture.Manager.GetStatus(fixture.Host.SessionId).Room.State);
        }

        [Fact]
        public async Task ActiveBuffering_HoldsEveryoneAndResumesWhenReady()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Sink.Commands.Clear();

            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayBuffering", new SyncPlaySocketEnvelope
            {
                MemberToken = joined.MemberToken,
                IsActive = true,
                IsBuffering = true,
                IsReady = false
            }, CancellationToken.None);

            Assert.Equal("Holding", fixture.Manager.GetStatus(fixture.Host.SessionId).Room.State);
            Assert.Contains(fixture.Sink.Commands.Select(item => item.Data).OfType<SyncPlayCommand>(), command => command.Kind == "Hold");

            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayBuffering", new SyncPlaySocketEnvelope
            {
                MemberToken = joined.MemberToken,
                IsActive = true,
                IsBuffering = false,
                IsReady = true
            }, CancellationToken.None);

            Assert.Equal("Playing", fixture.Manager.GetStatus(fixture.Host.SessionId).Room.State);
            Assert.Contains(fixture.Sink.Commands.Select(item => item.Data).OfType<SyncPlayCommand>(), command => command.Kind == "Resume");
        }

        [Theory]
        [InlineData(120, "Nudge")]
        [InlineData(700, "Correct")]
        public async Task Heartbeat_UsesSoftThenHardCorrection(int driftMs, string expectedKind)
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            fixture.Sink.Commands.Clear();

            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayHeartbeat", new SyncPlaySocketEnvelope
            {
                MemberToken = created.MemberToken,
                IsActive = true,
                IsReady = true,
                PositionTicks = TimeSpan.FromSeconds(12).Ticks + (driftMs * TimeSpan.TicksPerMillisecond)
            }, CancellationToken.None);

            var correction = Assert.Single(fixture.Sink.Commands.Select(item => item.Data).OfType<SyncPlayCommand>());
            Assert.Equal(expectedKind, correction.Kind);
        }

        [Fact]
        public void LastMemberLeaving_RemovesRoomAndToken()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();

            Assert.True(fixture.Manager.LeaveRoom(fixture.Host.SessionId));
            Assert.Null(fixture.Manager.GetRoom(created.Room.Code, fixture.Host.SessionId));
        }

        [Fact]
        public async Task InitialJoinStop_DoesNotRemoveInactiveMember()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);

            Assert.False(fixture.Manager.HandlePlaybackStopped(fixture.Guest.SessionId));
            Assert.Equal(2, fixture.Manager.GetRoom(created.Room.Code, fixture.Host.SessionId).MemberCount);
        }

        [Fact]
        public async Task RoomStateBroadcast_PreservesCreatorFlagPerRecipient()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);

            var hostState = fixture.Sink.Commands
                .Where(command => command.SessionId == fixture.Host.SessionId && command.MessageName == "SyncPlayRoomState")
                .Select(command => command.Data)
                .OfType<RoomDto>()
                .Last();
            var guestState = fixture.Sink.Commands
                .Where(command => command.SessionId == fixture.Guest.SessionId && command.MessageName == "SyncPlayRoomState")
                .Select(command => command.Data)
                .OfType<RoomDto>()
                .Last();

            Assert.True(hostState.IsCreator);
            Assert.False(guestState.IsCreator);
        }

        [Fact]
        public async Task HostStop_KeepsRoomAndMembersWhileAwaitingNextPlayback()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);

            var stopped = fixture.Manager.HandlePlaybackStopped(
                fixture.Host.SessionId,
                42,
                "host-play-1",
                false);

            var status = fixture.Manager.GetStatus(fixture.Host.SessionId);
            Assert.True(stopped.Handled);
            Assert.False(stopped.MembershipEnded);
            Assert.Equal("AwaitingHostPlayback", status.Room.MediaTransitionState);
            Assert.Equal(2, status.Room.MemberCount);
            Assert.True(status.Room.TransitionDeadlineUnixMs > fixture.Clock.UnixTimeMilliseconds);
        }

        [Fact]
        public async Task ViewerStartingUnexpectedMedia_OnlyRemovesThatViewer()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Sink.Commands.Clear();

            var result = await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Guest.SessionId,
                99,
                "Other movie",
                0,
                false,
                "guest-other",
                CancellationToken.None);

            Assert.True(result.MembershipEnded);
            Assert.Null(fixture.Manager.GetStatus(fixture.Guest.SessionId));
            Assert.NotNull(fixture.Manager.GetStatus(fixture.Host.SessionId));
            Assert.Equal(1, fixture.Manager.GetRoom(created.Room.Code, fixture.Host.SessionId).MemberCount);
            Assert.Contains(fixture.Sink.Commands, command =>
                command.SessionId == fixture.Guest.SessionId && command.MessageName == "SyncPlayMembershipEnded");
        }

        [Fact]
        public async Task HostStartingNewMedia_HoldsHostLoadsViewersAndAdvancesEpoch()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);
            fixture.Sink.Commands.Clear();

            var result = await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Host.SessionId,
                84,
                "Episode 2",
                TimeSpan.FromSeconds(7).Ticks,
                false,
                "host-new",
                CancellationToken.None);

            var room = fixture.Manager.GetStatus(fixture.Host.SessionId).Room;
            Assert.Equal(created.Room.MediaEpoch + 1, result.MediaEpoch);
            Assert.Equal(84, room.ItemId);
            Assert.Equal("Episode 2", room.ItemName);
            Assert.Equal("LoadingMembers", room.MediaTransitionState);
            Assert.Equal("MediaSwitch", room.HoldReason);
            Assert.Contains(fixture.Sink.Commands.Select(command => command.Data).OfType<SyncPlayCommand>(), command =>
                command.Kind == "Hold" && command.MediaEpoch == result.MediaEpoch);
            Assert.Contains(fixture.Sink.Commands.Where(command => command.SessionId == fixture.Guest.SessionId)
                .Select(command => command.Data).OfType<SyncPlayCommand>(), command =>
                command.Kind == "Load" && command.ItemId == 84 && command.MediaEpoch == result.MediaEpoch);
        }

        [Fact]
        public async Task AllMembersReady_ResumesAtOneServerTime()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);
            var started = await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Host.SessionId, 84, "Episode 2", 0, false, "host-new", CancellationToken.None);
            fixture.Sink.Commands.Clear();

            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayMediaReady", new SyncPlaySocketEnvelope
            {
                MemberToken = created.MemberToken,
                MediaEpoch = started.MediaEpoch,
                ItemId = 84,
                PlaySessionId = "host-new"
            }, CancellationToken.None);
            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayMediaReady", new SyncPlaySocketEnvelope
            {
                MemberToken = joined.MemberToken,
                MediaEpoch = started.MediaEpoch,
                ItemId = 84,
                PlaySessionId = "guest-new"
            }, CancellationToken.None);

            var status = fixture.Manager.GetStatus(fixture.Host.SessionId).Room;
            Assert.Equal("None", status.MediaTransitionState);
            Assert.Equal("Playing", status.State);
            var resumes = fixture.Sink.Commands.Select(command => command.Data).OfType<SyncPlayCommand>()
                .Where(command => command.Kind == "Resume").ToList();
            Assert.Equal(2, resumes.Count);
            Assert.Single(resumes.Select(command => command.ExecuteAtUnixMs).Distinct());
        }

        [Fact]
        public async Task LoadingTimeout_RetriesThenReleasesReadyMembersAndLateViewerCatchesUp()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);
            var started = await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Host.SessionId, 84, "Episode 2", 0, false, "host-new", CancellationToken.None);
            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayMediaReady", new SyncPlaySocketEnvelope
            {
                MemberToken = created.MemberToken,
                MediaEpoch = started.MediaEpoch,
                ItemId = 84
            }, CancellationToken.None);
            fixture.Sink.Commands.Clear();

            fixture.Clock.Advance(TimeSpan.FromSeconds(5));
            var retry = await fixture.Manager.ProcessMediaTransitionTimeoutsAsync(CancellationToken.None);
            Assert.Equal(1, retry.LoadsRetried);
            Assert.Contains(fixture.Sink.Commands.Where(command => command.SessionId == fixture.Guest.SessionId)
                .Select(command => command.Data).OfType<SyncPlayCommand>(), command => command.Kind == "Load");

            fixture.Clock.Advance(TimeSpan.FromSeconds(10));
            var timeout = await fixture.Manager.ProcessMediaTransitionTimeoutsAsync(CancellationToken.None);
            Assert.Equal(1, timeout.LoadingBarriersReleased);
            Assert.Equal("None", fixture.Manager.GetStatus(fixture.Host.SessionId).Room.MediaTransitionState);
            Assert.True(fixture.Manager.GetStatus(fixture.Guest.SessionId).Room.Members
                .Single(member => !member.IsCreator).MediaLoadTimedOut);

            fixture.Sink.Commands.Clear();
            await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Guest.SessionId, 84, "Episode 2", 0, true, "guest-new", CancellationToken.None);
            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayMediaReady", new SyncPlaySocketEnvelope
            {
                MemberToken = joined.MemberToken,
                MediaEpoch = started.MediaEpoch,
                ItemId = 84
            }, CancellationToken.None);
            var catchUp = fixture.Sink.Commands.Where(command => command.SessionId == fixture.Guest.SessionId)
                .Select(command => command.Data).OfType<SyncPlayCommand>().ToList();
            Assert.Contains(catchUp, command => command.Kind == "Correct" && command.Reason == "MediaSwitchLateReady");
            Assert.Contains(catchUp, command => command.Kind == "Resume" && command.Reason == "MediaSwitchLateReady");
        }

        [Fact]
        public async Task AwaitingHostTimeout_ClosesRoomForEveryone()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);

            fixture.Clock.Advance(TimeSpan.FromMinutes(5));
            var result = await fixture.Manager.ProcessMediaTransitionTimeoutsAsync(CancellationToken.None);

            Assert.Equal(1, result.RoomsClosed);
            Assert.Null(fixture.Manager.GetRoom(created.Room.Code, fixture.Host.SessionId));
            Assert.Null(fixture.Manager.GetStatus(fixture.Guest.SessionId));
        }

        [Fact]
        public async Task CreatorLeaving_ClosesRoomInsteadOfTransferringOwnership()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Sink.Commands.Clear();

            Assert.True(fixture.Manager.LeaveRoom(fixture.Host.SessionId));

            Assert.Null(fixture.Manager.GetRoom(created.Room.Code, fixture.Host.SessionId));
            Assert.Null(fixture.Manager.GetStatus(fixture.Guest.SessionId));
            Assert.Contains(fixture.Sink.Commands, command => command.MessageName == "SyncPlayRoomClosed");
        }

        [Fact]
        public async Task LateOldStopAndStaleEpochReady_DoNotAffectNewMedia()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            var joined = await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);
            var started = await fixture.Manager.HandlePlaybackStartedAsync(
                fixture.Host.SessionId, 84, "Episode 2", 0, false, "host-new", CancellationToken.None);

            var oldStop = fixture.Manager.HandlePlaybackStopped(fixture.Guest.SessionId, 42, "guest-old", false);
            await fixture.Manager.ProcessSocketMessageAsync("SyncPlayMediaReady", new SyncPlaySocketEnvelope
            {
                MemberToken = joined.MemberToken,
                MediaEpoch = started.MediaEpoch - 1,
                ItemId = 42
            }, CancellationToken.None);

            Assert.Equal("ExpectedOldMediaStop", oldStop.Reason);
            var status = fixture.Manager.GetStatus(fixture.Guest.SessionId);
            Assert.NotNull(status);
            Assert.Equal("LoadingMembers", status.Room.MediaTransitionState);
            Assert.Equal(0, status.Room.ReadyMemberCount);
        }

        [Fact]
        public async Task ViewerJoiningWhileHostSelectsMedia_KeepsMembershipWhenOldPlaybackStops()
        {
            var fixture = new Fixture();
            var created = fixture.CreateRoom();
            fixture.Manager.HandlePlaybackStopped(fixture.Host.SessionId, 42, "host-old", false);

            await fixture.Manager.JoinRoomAsync(created.Room.Code, fixture.Guest, CancellationToken.None);
            var oldStop = fixture.Manager.HandlePlaybackStopped(
                fixture.Guest.SessionId,
                99,
                "guest-previous-media",
                false);

            Assert.Equal("ExpectedOldMediaStop", oldStop.Reason);
            Assert.NotNull(fixture.Manager.GetStatus(fixture.Guest.SessionId));
            Assert.Equal("AwaitingHostPlayback",
                fixture.Manager.GetStatus(fixture.Guest.SessionId).Room.MediaTransitionState);
        }

        private sealed class Fixture
        {
            public Fixture()
            {
                Clock = new FakeClock(new DateTimeOffset(2026, 7, 12, 0, 0, 0, TimeSpan.Zero));
                Sink = new FakeSink();
                Manager = new RoomManager(Clock, Sink, () => new PluginConfiguration());
            }

            public FakeClock Clock { get; }
            public FakeSink Sink { get; }
            public RoomManager Manager { get; }

            public SessionDescriptor Host { get; } = new SessionDescriptor
            {
                SessionId = "host-session",
                UserId = "1",
                UserName = "Host",
                DeviceName = "Chrome"
            };

            public SessionDescriptor Guest { get; } = new SessionDescriptor
            {
                SessionId = "guest-session",
                UserId = "2",
                UserName = "Guest",
                DeviceName = "Edge"
            };

            public JoinRoomResult CreateRoom()
            {
                return Manager.CreateRoom(
                    Host,
                    42,
                    "Episode 1",
                    TimeSpan.FromSeconds(12).Ticks,
                    false,
                    "Room");
            }
        }

        private sealed class FakeClock : ISyncPlayClock
        {
            public FakeClock(DateTimeOffset now)
            {
                UtcNow = now;
            }

            public DateTimeOffset UtcNow { get; private set; }
            public long UnixTimeMilliseconds => UtcNow.ToUnixTimeMilliseconds();

            public void Advance(TimeSpan duration)
            {
                UtcNow = UtcNow.Add(duration);
            }
        }

        private sealed class FakeSink : ISyncPlayCommandSink
        {
            public ConcurrentBag<SentCommand> Commands { get; private set; } = new ConcurrentBag<SentCommand>();

            public Task SendAsync(string sessionId, string messageName, object data, CancellationToken cancellationToken)
            {
                Commands.Add(new SentCommand { SessionId = sessionId, MessageName = messageName, Data = data });
                return Task.CompletedTask;
            }
        }

        private sealed class SentCommand
        {
            public string SessionId { get; set; }
            public string MessageName { get; set; }
            public object Data { get; set; }
        }
    }
}
