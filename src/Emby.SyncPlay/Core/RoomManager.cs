using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Emby.SyncPlay.Core
{
    public interface ISyncPlayCommandSink
    {
        Task SendAsync(string sessionId, string messageName, object data, CancellationToken cancellationToken);
    }

    internal sealed class MembershipReference
    {
        public string RoomCode { get; set; }
        public string SessionId { get; set; }
    }

    public sealed class RoomManager
    {
        private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        private const long HostPlaybackSelectionTimeoutMs = 5 * 60 * 1000;
        private const long MediaLoadRetryDelayMs = 5 * 1000;
        private const long MediaLoadTimeoutMs = 15 * 1000;
        private readonly ConcurrentDictionary<string, SyncPlayRoom> _rooms =
            new ConcurrentDictionary<string, SyncPlayRoom>(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, MembershipReference> _tokens =
            new ConcurrentDictionary<string, MembershipReference>(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, string> _sessionRooms =
            new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly ISyncPlayClock _clock;
        private readonly ISyncPlayCommandSink _commandSink;
        private readonly Func<PluginConfiguration> _configuration;

        public RoomManager(
            ISyncPlayClock clock,
            ISyncPlayCommandSink commandSink,
            Func<PluginConfiguration> configuration)
        {
            _clock = clock ?? throw new ArgumentNullException(nameof(clock));
            _commandSink = commandSink ?? throw new ArgumentNullException(nameof(commandSink));
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        }

        public JoinRoomResult CreateRoom(
            SessionDescriptor session,
            long itemId,
            string itemName,
            long positionTicks,
            bool isPaused,
            string roomName)
        {
            ValidateSession(session);
            if (itemId <= 0)
            {
                throw new InvalidOperationException("Start playing a video before creating a room.");
            }

            LeaveRoom(session.SessionId);
            var now = _clock.UtcNow;
            var nowMs = _clock.UnixTimeMilliseconds;
            var room = new SyncPlayRoom
            {
                Name = NormalizeRoomName(roomName, session.UserName),
                CreatorSessionId = session.SessionId,
                ItemId = itemId,
                ItemName = itemName ?? string.Empty,
                PositionTicks = Math.Max(0, positionTicks),
                ReferenceUnixMs = nowMs,
                State = isPaused ? RoomPlaybackState.Paused : RoomPlaybackState.Playing,
                StateBeforeHold = isPaused ? RoomPlaybackState.Paused : RoomPlaybackState.Playing,
                Revision = 1,
                MediaEpoch = 1,
                MediaTransitionState = MediaTransitionState.None,
                CreatedAt = now,
                LastActivityAt = now
            };

            var member = CreateMember(session, isPaused);
            member.MediaEpoch = room.MediaEpoch;
            member.CurrentItemId = itemId;
            member.IsMediaReady = true;
            room.Members[session.SessionId] = member;
            AddRoomWithUniqueCode(room);

            RegisterMember(room, member);
            return BuildJoinResult(room, member);
        }

        public async Task<JoinRoomResult> JoinRoomAsync(
            string roomCode,
            SessionDescriptor session,
            CancellationToken cancellationToken)
        {
            ValidateSession(session);
            if (!_rooms.TryGetValue(NormalizeCode(roomCode), out var room))
            {
                throw new KeyNotFoundException("Room not found.");
            }

            LeaveRoom(session.SessionId);
            SyncPlayMember member;
            SyncPlayCommand playCommand;
            lock (room.Gate)
            {
                var config = GetConfiguration();
                if (room.Members.Count >= config.MaxMembersPerRoom)
                {
                    throw new InvalidOperationException("Room is full.");
                }

                member = CreateMember(session, true);
                member.IsActive = false;
                member.IsReady = false;
                member.MediaEpoch = room.MediaEpoch;
                member.CurrentItemId = room.ItemId;
                member.IsMediaLoading = true;
                member.IsMediaReady = false;
                room.Members[session.SessionId] = member;
                room.LastActivityAt = _clock.UtcNow;
                room.Revision++;
                RegisterMember(room, member);

                playCommand = BuildCommand(room, "Load", session.SessionId, _clock.UnixTimeMilliseconds);
            }

            await _commandSink.SendAsync(session.SessionId, "SyncPlayCommand", playCommand, cancellationToken)
                .ConfigureAwait(false);
            await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            return BuildJoinResult(room, member);
        }

        public RoomDto GetRoom(string code, string requestingSessionId)
        {
            if (!_rooms.TryGetValue(NormalizeCode(code), out var room))
            {
                return null;
            }

            lock (room.Gate)
            {
                return MapRoom(room, requestingSessionId);
            }
        }

        public JoinRoomResult GetStatus(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId) ||
                !_sessionRooms.TryGetValue(sessionId, out var roomCode) ||
                !_rooms.TryGetValue(roomCode, out var room))
            {
                return null;
            }

            lock (room.Gate)
            {
                if (!room.Members.TryGetValue(sessionId, out var member))
                {
                    return null;
                }

                return BuildJoinResult(room, member);
            }
        }

        public bool LeaveRoom(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId) ||
                !_sessionRooms.TryGetValue(sessionId, out var roomCode) ||
                !_rooms.TryGetValue(roomCode, out var room))
            {
                return false;
            }

            lock (room.Gate)
            {
                if (string.Equals(room.CreatorSessionId, sessionId, StringComparison.OrdinalIgnoreCase))
                {
                    return CloseRoomInternal(room, "CreatorLeft");
                }
            }

            _sessionRooms.TryRemove(sessionId, out _);
            SyncPlayMember member = null;
            var removeRoom = false;
            lock (room.Gate)
            {
                if (room.Members.TryGetValue(sessionId, out member))
                {
                    room.Members.Remove(sessionId);
                    room.Revision++;
                    room.LastActivityAt = _clock.UtcNow;
                }

                removeRoom = room.Members.Count == 0;
            }

            if (member != null)
            {
                _tokens.TryRemove(member.Token, out _);
            }

            if (removeRoom)
            {
                _rooms.TryRemove(roomCode, out _);
            }
            else
            {
                _ = BroadcastStateAsync(room, CancellationToken.None);
                _ = TryCompleteMediaLoadingAsync(room, sessionId, CancellationToken.None);
            }

            return member != null;
        }

        public bool HandlePlaybackStopped(string sessionId)
        {
            var result = HandlePlaybackStopped(sessionId, 0, null, false);
            return result.Handled && !string.Equals(result.Reason, "InactiveInitialLoad", StringComparison.Ordinal);
        }

        public PlaybackTransitionResult HandlePlaybackStopped(
            string sessionId,
            long itemId,
            string playSessionId,
            bool isCompleted)
        {
            if (string.IsNullOrWhiteSpace(sessionId) ||
                !_sessionRooms.TryGetValue(sessionId, out var roomCode) ||
                !_rooms.TryGetValue(roomCode, out var room))
            {
                return new PlaybackTransitionResult();
            }

            lock (room.Gate)
            {
                if (!room.Members.TryGetValue(sessionId, out var member))
                {
                    return new PlaybackTransitionResult();
                }

                var isCreator = string.Equals(room.CreatorSessionId, sessionId, StringComparison.OrdinalIgnoreCase);
                var effectiveItemId = itemId > 0 ? itemId : member.CurrentItemId;
                var isLateOldStop = effectiveItemId > 0 && effectiveItemId != room.ItemId &&
                    (room.MediaTransitionState == MediaTransitionState.LoadingMembers || member.IsMediaLoading);
                var isStalePlaySession = !string.IsNullOrWhiteSpace(playSessionId) &&
                    !string.IsNullOrWhiteSpace(member.PlaySessionId) &&
                    !string.Equals(playSessionId, member.PlaySessionId, StringComparison.Ordinal);

                if (isLateOldStop || isStalePlaySession)
                {
                    return Result(true, false, false, "ExpectedOldMediaStop", room.MediaEpoch);
                }

                if (!member.IsActive && room.MediaTransitionState == MediaTransitionState.None)
                {
                    return Result(false, false, false, "InactiveInitialLoad", room.MediaEpoch);
                }

                if (isCreator)
                {
                    if (room.MediaTransitionState == MediaTransitionState.AwaitingHostPlayback)
                    {
                        return Result(true, false, false, "AlreadyAwaitingHostPlayback", room.MediaEpoch);
                    }

                    room.MediaTransitionState = MediaTransitionState.AwaitingHostPlayback;
                    room.TransitionDeadlineUnixMs = _clock.UnixTimeMilliseconds + HostPlaybackSelectionTimeoutMs;
                    room.LoadRetryAtUnixMs = 0;
                    room.LoadRetrySent = false;
                    room.HoldReason = null;
                    room.Revision++;
                    room.LastActivityAt = _clock.UtcNow;
                    member.IsActive = false;
                    member.IsMediaLoading = false;
                    member.IsMediaReady = false;
                    _ = BroadcastStateAsync(room, CancellationToken.None);
                    return Result(true, false, false, "AwaitingHostPlayback", room.MediaEpoch);
                }

                if (room.MediaTransitionState == MediaTransitionState.AwaitingHostPlayback && isCompleted &&
                    (effectiveItemId <= 0 || effectiveItemId == room.ItemId))
                {
                    member.IsActive = false;
                    member.IsPaused = true;
                    return Result(true, false, false, "ViewerReachedEndWhileAwaitingHost", room.MediaEpoch);
                }
            }

            var left = LeaveRoom(sessionId);
            return Result(left, left, false, left ? "ViewerStopped" : null, 0);
        }

        public bool CloseRoom(string code, string sessionId, bool isAdministrator)
        {
            if (!_rooms.TryGetValue(NormalizeCode(code), out var room))
            {
                return false;
            }

            lock (room.Gate)
            {
                if (!isAdministrator && !string.Equals(room.CreatorSessionId, sessionId, StringComparison.OrdinalIgnoreCase))
                {
                    throw new UnauthorizedAccessException("Only the room creator or an administrator can close the room.");
                }
            }

            return CloseRoomInternal(room, "Closed");
        }

        public async Task<PlaybackTransitionResult> HandlePlaybackStartedAsync(
            string sessionId,
            long itemId,
            string itemName,
            long positionTicks,
            bool isPaused,
            string playSessionId,
            CancellationToken cancellationToken)
        {
            if (itemId <= 0 || string.IsNullOrWhiteSpace(sessionId) ||
                !_sessionRooms.TryGetValue(sessionId, out var roomCode) ||
                !_rooms.TryGetValue(roomCode, out var room))
            {
                return new PlaybackTransitionResult();
            }

            SyncPlayMember member;
            var leaveViewer = false;
            var beginTransition = false;
            var hostOnly = false;
            SyncPlayCommand holdCommand = null;
            SyncPlayCommand loadCommand = null;
            List<string> viewerSessionIds = null;
            long resultEpoch;

            lock (room.Gate)
            {
                if (!room.Members.TryGetValue(sessionId, out member))
                {
                    return new PlaybackTransitionResult();
                }

                var isCreator = string.Equals(room.CreatorSessionId, sessionId, StringComparison.OrdinalIgnoreCase);
                if (!isCreator && itemId != room.ItemId)
                {
                    leaveViewer = true;
                    resultEpoch = room.MediaEpoch;
                }
                else if (!isCreator)
                {
                    var isLateTimedOutMember = member.MediaLoadTimedOut &&
                        room.MediaTransitionState == MediaTransitionState.None;
                    member.CurrentItemId = itemId;
                    member.PlaySessionId = playSessionId;
                    member.MediaEpoch = room.MediaEpoch;
                    member.IsPaused = isPaused;
                    member.IsActive = room.MediaTransitionState != MediaTransitionState.LoadingMembers &&
                        !isLateTimedOutMember;
                    member.IsMediaLoading = room.MediaTransitionState == MediaTransitionState.LoadingMembers ||
                        isLateTimedOutMember;
                    member.IsMediaReady = room.MediaTransitionState != MediaTransitionState.LoadingMembers &&
                        !isLateTimedOutMember;
                    if (!isLateTimedOutMember)
                    {
                        member.MediaLoadTimedOut = false;
                    }
                    resultEpoch = room.MediaEpoch;
                }
                else
                {
                    var isNewHostPlayback = room.MediaTransitionState != MediaTransitionState.None || itemId != room.ItemId;
                    if (!isNewHostPlayback)
                    {
                        member.CurrentItemId = itemId;
                        member.PlaySessionId = playSessionId;
                        member.IsPaused = isPaused;
                        member.IsActive = true;
                        member.IsMediaReady = true;
                        resultEpoch = room.MediaEpoch;
                    }
                    else
                    {
                        beginTransition = true;
                        var nowMs = _clock.UnixTimeMilliseconds;
                        room.PreviousItemId = room.ItemId;
                        room.ItemId = itemId;
                        room.ItemName = itemName ?? string.Empty;
                        room.PositionTicks = Math.Max(0, positionTicks);
                        room.ReferenceUnixMs = nowMs;
                        room.MediaEpoch++;
                        room.Revision++;
                        room.LastActivityAt = _clock.UtcNow;
                        room.StateBeforeHold = isPaused ? RoomPlaybackState.Paused : RoomPlaybackState.Playing;

                        foreach (var candidate in room.Members.Values)
                        {
                            candidate.MediaEpoch = room.MediaEpoch;
                            candidate.IsMediaLoading = true;
                            candidate.IsMediaReady = false;
                            candidate.MediaLoadTimedOut = false;
                            candidate.IsActive = false;
                            candidate.IsReady = false;
                            candidate.IsBuffering = false;
                        }

                        member.CurrentItemId = itemId;
                        member.PlaySessionId = playSessionId;
                        member.IsPaused = true;

                        if (room.Members.Count == 1)
                        {
                            hostOnly = true;
                            room.MediaTransitionState = MediaTransitionState.None;
                            room.TransitionDeadlineUnixMs = 0;
                            room.LoadRetryAtUnixMs = 0;
                            room.LoadRetrySent = false;
                            room.HoldReason = null;
                            room.State = room.StateBeforeHold;
                            member.IsMediaLoading = false;
                            member.IsMediaReady = true;
                            member.IsReady = true;
                            member.IsActive = true;
                            member.IsPaused = isPaused;
                        }
                        else
                        {
                            room.MediaTransitionState = MediaTransitionState.LoadingMembers;
                            room.TransitionDeadlineUnixMs = nowMs + MediaLoadTimeoutMs;
                            room.LoadRetryAtUnixMs = nowMs + MediaLoadRetryDelayMs;
                            room.LoadRetrySent = false;
                            room.HoldReason = "MediaSwitch";
                            room.State = RoomPlaybackState.Holding;
                            holdCommand = BuildCommand(room, "Hold", sessionId, nowMs);
                            holdCommand.Reason = "MediaSwitch";
                            loadCommand = BuildCommand(room, "Load", sessionId, nowMs);
                            loadCommand.Reason = "MediaSwitch";
                            viewerSessionIds = room.Members.Keys
                                .Where(id => !string.Equals(id, sessionId, StringComparison.OrdinalIgnoreCase))
                                .ToList();
                        }

                        resultEpoch = room.MediaEpoch;
                    }
                }
            }

            if (leaveViewer)
            {
                await RemoveViewerForMediaChangeAsync(room, member, cancellationToken).ConfigureAwait(false);
                return Result(true, true, false, "ViewerChangedMedia", resultEpoch);
            }

            if (beginTransition && !hostOnly)
            {
                await _commandSink.SendAsync(sessionId, "SyncPlayCommand", holdCommand, cancellationToken)
                    .ConfigureAwait(false);
                var sends = viewerSessionIds.Select(id =>
                    _commandSink.SendAsync(id, "SyncPlayCommand", loadCommand, cancellationToken));
                await Task.WhenAll(sends).ConfigureAwait(false);
            }

            await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            return Result(true, false, false, beginTransition ? "HostMediaTransitionStarted" : "ExpectedMediaStarted", resultEpoch);
        }

        public async Task<bool> ProcessSocketMessageAsync(
            string messageType,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            if (envelope == null || string.IsNullOrWhiteSpace(envelope.MemberToken) ||
                !_tokens.TryGetValue(envelope.MemberToken, out var membership) ||
                !_rooms.TryGetValue(membership.RoomCode, out var room))
            {
                return false;
            }

            SyncPlayMember member;
            lock (room.Gate)
            {
                if (!room.Members.TryGetValue(membership.SessionId, out member) ||
                    !string.Equals(member.Token, envelope.MemberToken, StringComparison.Ordinal))
                {
                    return false;
                }

                // A browser reload keeps the room membership token but starts
                // its sequence counter from zero. Scope the counter to a page
                // instance so reconnecting cannot make every control stale.
                if (!string.IsNullOrWhiteSpace(envelope.ClientInstanceId) &&
                    !string.Equals(member.ClientInstanceId, envelope.ClientInstanceId, StringComparison.Ordinal))
                {
                    if (member.RetiredClientInstances.Contains(envelope.ClientInstanceId))
                    {
                        return false;
                    }
                    if (!string.IsNullOrEmpty(member.ClientInstanceId))
                    {
                        member.RetiredClientInstances.Add(member.ClientInstanceId);
                    }
                    member.ClientInstanceId = envelope.ClientInstanceId;
                    member.LastClientSequence = 0;
                }
            }

            switch (messageType)
            {
                case "SyncPlayClockPing":
                    await SendClockPongAsync(member, envelope, cancellationToken).ConfigureAwait(false);
                    return true;
                case "SyncPlayControl":
                    return await HandleControlAsync(room, member, envelope, cancellationToken).ConfigureAwait(false);
                case "SyncPlayHeartbeat":
                    return await HandleHeartbeatAsync(room, member, envelope, cancellationToken).ConfigureAwait(false);
                case "SyncPlayBuffering":
                    return await HandleBufferingAsync(room, member, envelope, cancellationToken).ConfigureAwait(false);
                case "SyncPlayMediaReady":
                    return await HandleMediaReadyAsync(room, member, envelope, cancellationToken).ConfigureAwait(false);
                default:
                    return false;
            }
        }

        public async Task<MediaTransitionTickResult> ProcessMediaTransitionTimeoutsAsync(
            CancellationToken cancellationToken)
        {
            var result = new MediaTransitionTickResult();
            var nowMs = _clock.UnixTimeMilliseconds;
            foreach (var pair in _rooms.ToArray())
            {
                var room = pair.Value;
                var close = false;
                List<string> retrySessionIds = null;
                SyncPlayCommand retryCommand = null;
                List<string> resumeSessionIds = null;
                SyncPlayCommand resumeCommand = null;

                lock (room.Gate)
                {
                    if (room.MediaTransitionState == MediaTransitionState.AwaitingHostPlayback &&
                        room.TransitionDeadlineUnixMs > 0 && nowMs >= room.TransitionDeadlineUnixMs)
                    {
                        close = true;
                    }
                    else if (room.MediaTransitionState == MediaTransitionState.LoadingMembers)
                    {
                        if (room.TransitionDeadlineUnixMs > 0 && nowMs >= room.TransitionDeadlineUnixMs)
                        {
                            foreach (var candidate in room.Members.Values.Where(candidate => !candidate.IsMediaReady))
                            {
                                candidate.MediaLoadTimedOut = true;
                                candidate.IsMediaLoading = false;
                                candidate.IsActive = false;
                            }

                            resumeSessionIds = room.Members.Values
                                .Where(candidate => candidate.IsMediaReady)
                                .Select(candidate => candidate.SessionId)
                                .ToList();
                            resumeCommand = ReleaseMediaLoadingBarrier(room, nowMs, "MediaSwitchTimeout");
                        }
                        else if (!room.LoadRetrySent && room.LoadRetryAtUnixMs > 0 && nowMs >= room.LoadRetryAtUnixMs)
                        {
                            room.LoadRetrySent = true;
                            retrySessionIds = room.Members.Values
                                .Where(candidate => !candidate.IsMediaReady &&
                                    !string.Equals(candidate.SessionId, room.CreatorSessionId, StringComparison.OrdinalIgnoreCase))
                                .Select(candidate => candidate.SessionId)
                                .ToList();
                            if (retrySessionIds.Count > 0)
                            {
                                retryCommand = BuildCommand(room, "Load", room.CreatorSessionId, nowMs);
                                retryCommand.Reason = "MediaSwitchRetry";
                            }
                        }
                    }
                }

                if (close)
                {
                    if (CloseRoomInternal(room, "HostMediaSwitchTimeout"))
                    {
                        result.RoomsClosed++;
                    }
                    continue;
                }

                if (retryCommand != null)
                {
                    await Task.WhenAll(retrySessionIds.Select(id =>
                        _commandSink.SendAsync(id, "SyncPlayCommand", retryCommand, cancellationToken)))
                        .ConfigureAwait(false);
                    result.LoadsRetried++;
                }

                if (resumeCommand != null)
                {
                    await Task.WhenAll(resumeSessionIds.Select(id =>
                        _commandSink.SendAsync(id, "SyncPlayCommand", resumeCommand, cancellationToken)))
                        .ConfigureAwait(false);
                    await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
                    result.LoadingBarriersReleased++;
                }
            }

            return result;
        }

        public int CleanupExpiredRooms()
        {
            var threshold = _clock.UtcNow.AddMinutes(-GetConfiguration().EmptyRoomTimeoutMinutes);
            var removed = 0;
            foreach (var pair in _rooms.ToArray())
            {
                var stale = false;
                lock (pair.Value.Gate)
                {
                    stale = pair.Value.Members.Count == 0 || pair.Value.LastActivityAt < threshold;
                }

                if (stale && _rooms.TryRemove(pair.Key, out var room))
                {
                    foreach (var member in room.Members.Values)
                    {
                        _tokens.TryRemove(member.Token, out _);
                        _sessionRooms.TryRemove(member.SessionId, out _);
                    }

                    removed++;
                }
            }

            return removed;
        }

        private async Task<bool> HandleControlAsync(
            SyncPlayRoom room,
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            SyncPlayCommand command;
            lock (room.Gate)
            {
                if (room.MediaTransitionState != MediaTransitionState.None ||
                    !IsEnvelopeForCurrentMedia(room, envelope))
                {
                    return false;
                }

                if (envelope.ClientSequence <= member.LastClientSequence)
                {
                    return false;
                }

                member.LastClientSequence = envelope.ClientSequence;
                if (!Enum.TryParse(envelope.Kind, true, out SyncControlKind kind))
                {
                    return false;
                }

                if (room.State == RoomPlaybackState.Holding && kind == SyncControlKind.Play)
                {
                    return false;
                }

                // A client can reach a playable video before its Ready
                // heartbeat (or MediaReady event) crosses a WebSocket-less
                // proxy. A valid control for the current epoch proves that the
                // member has usable media, so clear a stale initial loading
                // barrier while accepting the control.
                if (room.MediaTransitionState == MediaTransitionState.None)
                {
                    member.IsMediaLoading = false;
                    member.IsMediaReady = true;
                    member.MediaLoadTimedOut = false;
                    member.IsReady = true;
                    member.IsActive = true;
                }

                var nowMs = _clock.UnixTimeMilliseconds;
                // The browser reports the position when the local control event
                // is emitted, while this request is handled a little later. For
                // controls that leave playback running, keep the room anchor at
                // the position reached when the server accepts the request.
                room.PositionTicks = EstimateControlPositionTicks(member, envelope, kind, nowMs);
                room.ReferenceUnixMs = nowMs;
                room.LastActivityAt = _clock.UtcNow;
                room.Revision++;
                room.State = kind == SyncControlKind.Pause
                    ? RoomPlaybackState.Paused
                    : kind == SyncControlKind.Play || kind == SyncControlKind.Seek
                        ? (envelope.IsPaused ? RoomPlaybackState.Paused : RoomPlaybackState.Playing)
                        : room.State;
                room.StateBeforeHold = room.State;
                member.PositionTicks = room.PositionTicks;
                member.IsPaused = room.State != RoomPlaybackState.Playing;
                command = BuildCommand(room, kind.ToString(), member.SessionId, nowMs);
                command.EventId = string.IsNullOrWhiteSpace(envelope.EventId)
                    ? Guid.NewGuid().ToString("N")
                    : envelope.EventId;
            }

            await BroadcastCommandAsync(room, command, member.SessionId, cancellationToken).ConfigureAwait(false);
            await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            return true;
        }

        private static long EstimateControlPositionTicks(
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            SyncControlKind kind,
            long nowMs)
        {
            var positionTicks = Math.Max(0, envelope.PositionTicks);
            if (envelope.IsPaused || (kind != SyncControlKind.Play && kind != SyncControlKind.Seek))
            {
                return positionTicks;
            }

            long transitMs = Math.Max(0, member.RoundTripTimeMs / 2);
            if (envelope.ClientUnixMs > 0 && envelope.ClientUnixMs <= nowMs)
            {
                // Do not let a stale clock sample create a multi-second jump.
                var stampedTransitMs = Math.Min(2000, nowMs - envelope.ClientUnixMs);
                transitMs = Math.Max(transitMs, stampedTransitMs);
            }

            return positionTicks + (transitMs * TimeSpan.TicksPerMillisecond);
        }

        private async Task<bool> HandleHeartbeatAsync(
            SyncPlayRoom room,
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            SyncPlayCommand correction = null;
            SyncPlayCommand releaseCommand = null;
            List<string> releaseSessionIds = null;
            var mediaStateChanged = false;
            lock (room.Gate)
            {
                if (!IsEnvelopeForCurrentMedia(room, envelope))
                {
                    return false;
                }

                var nowMs = _clock.UnixTimeMilliseconds;
                member.LastHeartbeatUnixMs = nowMs;
                member.PositionTicks = Math.Max(0, envelope.PositionTicks);
                member.IsPaused = envelope.IsPaused;
                member.IsBuffering = envelope.IsBuffering;
                member.IsReady = envelope.IsReady;
                member.IsActive = envelope.IsActive;
                member.RoundTripTimeMs = Math.Max(0, envelope.RoundTripTimeMs);
                room.LastActivityAt = _clock.UtcNow;

                // A Ready heartbeat is sufficient to complete the initial
                // join handshake. Older clients did not send MediaReady when
                // the room transition state was None, which left the member
                // permanently marked as loading even though playback worked.
                if (envelope.IsReady && !envelope.IsBuffering &&
                    room.MediaTransitionState == MediaTransitionState.None &&
                    (!member.IsMediaReady || member.IsMediaLoading || member.MediaLoadTimedOut))
                {
                    member.IsMediaReady = true;
                    member.IsMediaLoading = false;
                    member.MediaLoadTimedOut = false;
                    // Older clients sent IsActive=false while clearing the
                    // initial join loading flag. Once the room is out of a
                    // media transition, a buffered Ready heartbeat is an
                    // active playback participant.
                    member.IsActive = true;
                    mediaStateChanged = true;
                }

                // If a custom MediaReady message was lost by a WebSocket
                // proxy, promote a ready heartbeat while a media barrier is
                // active and release it as soon as every member is ready.
                if (envelope.IsReady && !envelope.IsBuffering &&
                    room.MediaTransitionState == MediaTransitionState.LoadingMembers &&
                    (!member.IsMediaReady || member.IsMediaLoading || member.MediaLoadTimedOut))
                {
                    member.IsMediaReady = true;
                    member.IsMediaLoading = false;
                    member.MediaLoadTimedOut = false;
                    mediaStateChanged = true;
                    if (AllMediaMembersReady(room))
                    {
                        releaseSessionIds = room.Members.Values
                            .Where(candidate => candidate.IsMediaReady)
                            .Select(candidate => candidate.SessionId)
                            .ToList();
                        releaseCommand = ReleaseMediaLoadingBarrier(room, nowMs, "HeartbeatReady");
                    }
                }

                if (room.MediaTransitionState == MediaTransitionState.None &&
                    room.State == RoomPlaybackState.Holding &&
                    !string.Equals(room.HoldReason, "MediaSwitch", StringComparison.Ordinal) &&
                    AllActiveMembersReady(room))
                {
                    room.State = room.StateBeforeHold == RoomPlaybackState.Paused
                        ? RoomPlaybackState.Paused : RoomPlaybackState.Playing;
                    room.ReferenceUnixMs = nowMs;
                    room.Revision++;
                    releaseSessionIds = room.Members.Values.Select(candidate => candidate.SessionId).ToList();
                    releaseCommand = BuildCommand(room, room.State == RoomPlaybackState.Playing ? "Resume" : "Pause", member.SessionId, nowMs);
                    releaseCommand.ExecuteAtUnixMs = nowMs + CalculateResumeLeadMs(room);
                }

                if (mediaStateChanged && releaseCommand == null)
                {
                    room.Revision++;
                }

                var expectedTicks = room.EstimatePositionTicks(nowMs);
                member.DriftMs = (int)((member.PositionTicks - expectedTicks) / TimeSpan.TicksPerMillisecond);
                var configuration = GetConfiguration();
                var hardThreshold = configuration.HardDriftThresholdMs;
                if (room.MediaTransitionState == MediaTransitionState.None &&
                    member.IsActive && !member.IsBuffering && room.State != RoomPlaybackState.Holding &&
                    Math.Abs(member.DriftMs) >= hardThreshold)
                {
                    correction = BuildCommand(room, "Correct", member.SessionId, nowMs);
                }
                else if (member.IsActive && !member.IsBuffering && room.State == RoomPlaybackState.Playing &&
                         Math.Abs(member.DriftMs) >= configuration.SoftDriftThresholdMs)
                {
                    correction = BuildCommand(room, "Nudge", member.SessionId, nowMs);
                }
            }

            if (releaseCommand != null)
            {
                await Task.WhenAll(releaseSessionIds.Select(id =>
                    _commandSink.SendAsync(id, "SyncPlayCommand", releaseCommand, cancellationToken)))
                    .ConfigureAwait(false);
            }

            if (mediaStateChanged || releaseCommand != null)
            {
                await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            }

            if (correction != null)
            {
                await _commandSink.SendAsync(member.SessionId, "SyncPlayCommand", correction, cancellationToken)
                    .ConfigureAwait(false);
            }

            return true;
        }

        private async Task<bool> HandleBufferingAsync(
            SyncPlayRoom room,
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            SyncPlayCommand command = null;
            lock (room.Gate)
            {
                if (!IsEnvelopeForCurrentMedia(room, envelope))
                {
                    return false;
                }

                member.IsBuffering = envelope.IsBuffering;
                member.IsReady = envelope.IsReady;
                member.IsActive = envelope.IsActive;
                room.LastActivityAt = _clock.UtcNow;
                var nowMs = _clock.UnixTimeMilliseconds;

                if (room.MediaTransitionState == MediaTransitionState.None &&
                    member.IsActive && envelope.IsBuffering && room.State != RoomPlaybackState.Holding)
                {
                    room.PositionTicks = room.EstimatePositionTicks(nowMs);
                    room.ReferenceUnixMs = nowMs;
                    room.StateBeforeHold = room.State;
                    room.State = RoomPlaybackState.Holding;
                    room.Revision++;
                    command = BuildCommand(room, "Hold", member.SessionId, nowMs);
                }
                else if (room.MediaTransitionState == MediaTransitionState.None &&
                    !envelope.IsBuffering && room.State == RoomPlaybackState.Holding &&
                    !string.Equals(room.HoldReason, "MediaSwitch", StringComparison.Ordinal) &&
                    AllActiveMembersReady(room))
                {
                    room.State = room.StateBeforeHold == RoomPlaybackState.Paused
                        ? RoomPlaybackState.Paused
                        : RoomPlaybackState.Playing;
                    room.ReferenceUnixMs = nowMs;
                    room.Revision++;
                    command = BuildCommand(room, room.State == RoomPlaybackState.Playing ? "Resume" : "Pause", member.SessionId, nowMs);
                    command.ExecuteAtUnixMs = nowMs + CalculateResumeLeadMs(room);
                }
            }

            if (command != null)
            {
                await BroadcastCommandAsync(room, command, null, cancellationToken).ConfigureAwait(false);
            }

            await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            return true;
        }

        private async Task<bool> HandleMediaReadyAsync(
            SyncPlayRoom room,
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            SyncPlayCommand releaseCommand = null;
            SyncPlayCommand catchUpCommand = null;
            SyncPlayCommand catchUpResumeCommand = null;
            List<string> releaseSessionIds = null;
            lock (room.Gate)
            {
                if ((envelope.MediaEpoch > 0 && envelope.MediaEpoch != room.MediaEpoch) ||
                    (envelope.ItemId > 0 && envelope.ItemId != room.ItemId))
                {
                    return false;
                }

                member.MediaEpoch = room.MediaEpoch;
                member.CurrentItemId = room.ItemId;
                member.PlaySessionId = envelope.PlaySessionId;
                member.IsMediaReady = true;
                member.IsMediaLoading = false;
                member.IsReady = true;
                member.IsBuffering = false;
                member.IsActive = true;
                room.LastActivityAt = _clock.UtcNow;

                var nowMs = _clock.UnixTimeMilliseconds;
                if (room.MediaTransitionState == MediaTransitionState.LoadingMembers && AllMediaMembersReady(room))
                {
                    releaseSessionIds = room.Members.Values
                        .Where(candidate => candidate.IsMediaReady)
                        .Select(candidate => candidate.SessionId)
                        .ToList();
                    releaseCommand = ReleaseMediaLoadingBarrier(room, nowMs, "MediaSwitchReady");
                }
                else if (room.MediaTransitionState == MediaTransitionState.None && member.MediaLoadTimedOut)
                {
                    member.MediaLoadTimedOut = false;
                    catchUpCommand = BuildCommand(room, "Correct", member.SessionId, nowMs);
                    catchUpCommand.Reason = "MediaSwitchLateReady";
                    if (room.State == RoomPlaybackState.Playing)
                    {
                        catchUpResumeCommand = BuildCommand(room, "Resume", member.SessionId, nowMs);
                        catchUpResumeCommand.Reason = "MediaSwitchLateReady";
                        catchUpResumeCommand.ExecuteAtUnixMs = nowMs + Math.Max(300, member.RoundTripTimeMs + 100);
                    }
                }
            }

            if (releaseCommand != null)
            {
                await Task.WhenAll(releaseSessionIds.Select(id =>
                    _commandSink.SendAsync(id, "SyncPlayCommand", releaseCommand, cancellationToken)))
                    .ConfigureAwait(false);
            }
            else if (catchUpCommand != null)
            {
                await _commandSink.SendAsync(member.SessionId, "SyncPlayCommand", catchUpCommand, cancellationToken)
                    .ConfigureAwait(false);
                if (catchUpResumeCommand != null)
                {
                    await _commandSink.SendAsync(member.SessionId, "SyncPlayCommand", catchUpResumeCommand, cancellationToken)
                        .ConfigureAwait(false);
                }
            }

            await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            return true;
        }

        private async Task TryCompleteMediaLoadingAsync(
            SyncPlayRoom room,
            string sourceSessionId,
            CancellationToken cancellationToken)
        {
            SyncPlayCommand command = null;
            List<string> sessionIds = null;
            lock (room.Gate)
            {
                if (room.MediaTransitionState == MediaTransitionState.LoadingMembers && AllMediaMembersReady(room))
                {
                    sessionIds = room.Members.Values
                        .Where(candidate => candidate.IsMediaReady)
                        .Select(candidate => candidate.SessionId)
                        .ToList();
                    command = ReleaseMediaLoadingBarrier(room, _clock.UnixTimeMilliseconds, "MemberLeftDuringMediaSwitch");
                    command.SourceSessionId = sourceSessionId;
                }
            }

            if (command != null)
            {
                await Task.WhenAll(sessionIds.Select(id =>
                    _commandSink.SendAsync(id, "SyncPlayCommand", command, cancellationToken)))
                    .ConfigureAwait(false);
                await BroadcastStateAsync(room, cancellationToken).ConfigureAwait(false);
            }
        }

        private Task SendClockPongAsync(
            SyncPlayMember member,
            SyncPlaySocketEnvelope envelope,
            CancellationToken cancellationToken)
        {
            var received = _clock.UnixTimeMilliseconds;
            var pong = new ClockPong
            {
                EventId = envelope.EventId,
                ClientUnixMs = envelope.ClientUnixMs,
                ServerReceiveUnixMs = received,
                ServerSendUnixMs = _clock.UnixTimeMilliseconds
            };
            return _commandSink.SendAsync(member.SessionId, "SyncPlayClockPong", pong, cancellationToken);
        }

        private async Task BroadcastCommandAsync(
            SyncPlayRoom room,
            SyncPlayCommand command,
            string excludedSessionId,
            CancellationToken cancellationToken)
        {
            List<string> sessionIds;
            lock (room.Gate)
            {
                sessionIds = room.Members.Keys
                    .Where(id => !string.Equals(id, excludedSessionId, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            var sends = sessionIds.Select(id =>
                _commandSink.SendAsync(id, "SyncPlayCommand", command, cancellationToken));
            await Task.WhenAll(sends).ConfigureAwait(false);
        }

        private async Task BroadcastStateAsync(SyncPlayRoom room, CancellationToken cancellationToken)
        {
            List<string> sessionIds;
            lock (room.Gate)
            {
                sessionIds = room.Members.Keys.ToList();
            }

            var sends = sessionIds.Select(id =>
            {
                RoomDto state;
                lock (room.Gate)
                {
                    state = MapRoom(room, id);
                }

                return _commandSink.SendAsync(id, "SyncPlayRoomState", state, cancellationToken);
            });
            await Task.WhenAll(sends).ConfigureAwait(false);
        }

        private SyncPlayCommand BuildCommand(SyncPlayRoom room, string kind, string sourceSessionId, long nowMs)
        {
            return new SyncPlayCommand
            {
                EventId = Guid.NewGuid().ToString("N"),
                Kind = kind,
                RoomRevision = room.Revision,
                MediaEpoch = room.MediaEpoch,
                ItemId = room.ItemId,
                ItemName = room.ItemName,
                PositionTicks = room.EstimatePositionTicks(nowMs),
                ReferenceUnixMs = nowMs,
                ExecuteAtUnixMs = nowMs,
                State = room.State.ToString(),
                SourceSessionId = sourceSessionId,
                Reason = room.HoldReason
            };
        }

        private JoinRoomResult BuildJoinResult(SyncPlayRoom room, SyncPlayMember member)
        {
            var config = GetConfiguration();
            return new JoinRoomResult
            {
                Room = MapRoom(room, member.SessionId),
                MemberToken = member.Token,
                HeartbeatIntervalMs = config.HeartbeatIntervalMs,
                SoftDriftThresholdMs = config.SoftDriftThresholdMs,
                HardDriftThresholdMs = config.HardDriftThresholdMs,
                ReadyBufferSeconds = config.ReadyBufferSeconds
            };
        }

        private RoomDto MapRoom(SyncPlayRoom room, string requestingSessionId)
        {
            var nowMs = _clock.UnixTimeMilliseconds;
            room.Members.TryGetValue(requestingSessionId ?? string.Empty, out var currentMember);
            return new RoomDto
            {
                Code = room.Code,
                Name = room.Name,
                ItemId = room.ItemId,
                ItemName = room.ItemName,
                State = room.State.ToString(),
                PositionTicks = room.EstimatePositionTicks(nowMs),
                ReferenceUnixMs = nowMs,
                Revision = room.Revision,
                MediaEpoch = room.MediaEpoch,
                MediaTransitionState = room.MediaTransitionState.ToString(),
                TransitionDeadlineUnixMs = room.TransitionDeadlineUnixMs,
                HoldReason = room.HoldReason,
                ReadyMemberCount = room.Members.Values.Count(member => member.IsMediaReady),
                LoadingMemberCount = room.Members.Values.Count(member => member.IsMediaLoading),
                IsCurrentMemberMediaLoading = currentMember?.IsMediaLoading ?? false,
                IsCurrentMemberMediaReady = currentMember?.IsMediaReady ?? false,
                IsCurrentMemberActive = currentMember?.IsActive ?? false,
                IsCreator = string.Equals(room.CreatorSessionId, requestingSessionId, StringComparison.OrdinalIgnoreCase),
                MemberCount = room.Members.Count,
                Members = room.Members.Values
                    .OrderByDescending(member => string.Equals(member.SessionId, room.CreatorSessionId, StringComparison.OrdinalIgnoreCase))
                    .ThenBy(member => member.JoinedAt)
                    .Select(member => new RoomMemberDto
                    {
                        Name = member.UserName,
                        Device = member.DeviceName,
                        IsCreator = string.Equals(member.SessionId, room.CreatorSessionId, StringComparison.OrdinalIgnoreCase),
                        IsBuffering = member.IsBuffering,
                        IsReady = member.IsReady,
                        IsActive = member.IsActive,
                        IsMediaLoading = member.IsMediaLoading,
                        IsMediaReady = member.IsMediaReady,
                        MediaLoadTimedOut = member.MediaLoadTimedOut,
                        RoundTripTimeMs = member.RoundTripTimeMs,
                        DriftMs = member.DriftMs
                    })
                    .ToList()
            };
        }

        private SyncPlayMember CreateMember(SessionDescriptor session, bool isPaused)
        {
            return new SyncPlayMember
            {
                SessionId = session.SessionId,
                UserId = session.UserId,
                UserName = string.IsNullOrWhiteSpace(session.UserName) ? "Emby User" : session.UserName,
                DeviceName = string.IsNullOrWhiteSpace(session.DeviceName) ? "Web" : session.DeviceName,
                Token = CreateSecureToken(24),
                IsPaused = isPaused,
                IsReady = true,
                IsActive = true,
                IsMediaReady = true,
                JoinedAt = _clock.UtcNow,
                LastHeartbeatUnixMs = _clock.UnixTimeMilliseconds
            };
        }

        private void RegisterMember(SyncPlayRoom room, SyncPlayMember member)
        {
            _sessionRooms[member.SessionId] = room.Code;
            _tokens[member.Token] = new MembershipReference
            {
                RoomCode = room.Code,
                SessionId = member.SessionId
            };
        }

        private void AddRoomWithUniqueCode(SyncPlayRoom room)
        {
            for (var attempt = 0; attempt < 64; attempt++)
            {
                var code = CreateNumericRoomCode();
                room.Code = code;
                if (_rooms.TryAdd(code, room))
                {
                    return;
                }
            }

            throw new InvalidOperationException("Could not allocate a unique room code.");
        }

        private bool CloseRoomInternal(SyncPlayRoom room, string reason)
        {
            if (room == null || !_rooms.TryRemove(room.Code, out var removedRoom))
            {
                return false;
            }

            List<SyncPlayMember> members;
            lock (removedRoom.Gate)
            {
                members = removedRoom.Members.Values.ToList();
                removedRoom.Members.Clear();
            }

            foreach (var member in members)
            {
                _sessionRooms.TryRemove(member.SessionId, out _);
                _tokens.TryRemove(member.Token, out _);
                _ = _commandSink.SendAsync(
                    member.SessionId,
                    "SyncPlayRoomClosed",
                    new { Code = removedRoom.Code, Reason = reason },
                    CancellationToken.None);
            }

            return true;
        }

        private async Task RemoveViewerForMediaChangeAsync(
            SyncPlayRoom room,
            SyncPlayMember member,
            CancellationToken cancellationToken)
        {
            var code = room.Code;
            var epoch = room.MediaEpoch;
            if (!LeaveRoom(member.SessionId))
            {
                return;
            }

            await _commandSink.SendAsync(
                    member.SessionId,
                    "SyncPlayMembershipEnded",
                    new { Code = code, Reason = "ViewerChangedMedia", MediaEpoch = epoch },
                    cancellationToken)
                .ConfigureAwait(false);
        }

        private SyncPlayCommand ReleaseMediaLoadingBarrier(SyncPlayRoom room, long nowMs, string reason)
        {
            room.MediaTransitionState = MediaTransitionState.None;
            room.TransitionDeadlineUnixMs = 0;
            room.LoadRetryAtUnixMs = 0;
            room.LoadRetrySent = false;
            room.HoldReason = null;
            room.State = room.StateBeforeHold == RoomPlaybackState.Paused
                ? RoomPlaybackState.Paused
                : RoomPlaybackState.Playing;
            room.ReferenceUnixMs = nowMs;
            room.Revision++;
            room.LastActivityAt = _clock.UtcNow;
            foreach (var candidate in room.Members.Values.Where(candidate => candidate.IsMediaReady))
            {
                candidate.IsMediaLoading = false;
                candidate.IsActive = true;
                candidate.IsPaused = room.State != RoomPlaybackState.Playing;
            }

            var command = BuildCommand(
                room,
                room.State == RoomPlaybackState.Playing ? "Resume" : "Pause",
                room.CreatorSessionId,
                nowMs);
            command.Reason = reason;
            command.ExecuteAtUnixMs = nowMs + CalculateResumeLeadMs(room);
            return command;
        }

        private static bool AllMediaMembersReady(SyncPlayRoom room)
        {
            return room.Members.Count > 0 && room.Members.Values
                .Where(member => !member.MediaLoadTimedOut)
                .All(member => member.IsMediaReady);
        }

        private static bool IsEnvelopeForCurrentMedia(SyncPlayRoom room, SyncPlaySocketEnvelope envelope)
        {
            return (envelope.MediaEpoch <= 0 || envelope.MediaEpoch == room.MediaEpoch) &&
                (envelope.ItemId <= 0 || envelope.ItemId == room.ItemId);
        }

        private static PlaybackTransitionResult Result(
            bool handled,
            bool membershipEnded,
            bool roomClosed,
            string reason,
            long mediaEpoch)
        {
            return new PlaybackTransitionResult
            {
                Handled = handled,
                MembershipEnded = membershipEnded,
                RoomClosed = roomClosed,
                Reason = reason,
                MediaEpoch = mediaEpoch
            };
        }

        private static string CreateNumericRoomCode()
        {
            const uint codeSpace = 1000;
            var upperBound = uint.MaxValue - (uint.MaxValue % codeSpace);
            var bytes = new byte[sizeof(uint)];
            uint value;
            using (var random = RandomNumberGenerator.Create())
            {
                do
                {
                    random.GetBytes(bytes);
                    value = BitConverter.ToUInt32(bytes, 0);
                }
                while (value >= upperBound);
            }

            return (value % codeSpace).ToString("D3", CultureInfo.InvariantCulture);
        }

        private static string CreateSecureToken(int length)
        {
            var bytes = new byte[length];
            using (var random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }

            var chars = new char[length];
            for (var i = 0; i < length; i++)
            {
                chars[i] = Alphabet[bytes[i] % Alphabet.Length];
            }

            return new string(chars);
        }

        private static string NormalizeRoomName(string roomName, string userName)
        {
            var value = string.IsNullOrWhiteSpace(roomName)
                ? (string.IsNullOrWhiteSpace(userName) ? "同步观影房间" : userName + " 的观影房间")
                : roomName.Trim();
            return value.Length > 40 ? value.Substring(0, 40) : value;
        }

        private static string NormalizeCode(string code)
        {
            var value = (code ?? string.Empty).Trim();
            return value.Length == 3 && value.All(character => character >= '0' && character <= '9')
                ? value
                : string.Empty;
        }

        private static void ValidateSession(SessionDescriptor session)
        {
            if (session == null || string.IsNullOrWhiteSpace(session.SessionId))
            {
                throw new InvalidOperationException("No active Emby session was found for this device.");
            }
        }

        private static bool AllActiveMembersReady(SyncPlayRoom room)
        {
            return room.Members.Values
                .Where(member => member.IsActive)
                .All(member => member.IsReady && !member.IsBuffering);
        }

        private static long CalculateResumeLeadMs(SyncPlayRoom room)
        {
            var rtts = room.Members.Values
                .Where(member => member.IsActive)
                .Select(member => Math.Max(0, member.RoundTripTimeMs))
                .OrderBy(value => value)
                .ToList();
            var p95 = rtts.Count == 0 ? 0 : rtts[(int)Math.Min(rtts.Count - 1, Math.Ceiling(rtts.Count * 0.95) - 1)];
            return Math.Max(300, p95 + 100);
        }

        private PluginConfiguration GetConfiguration()
        {
            var config = _configuration() ?? new PluginConfiguration();
            config.HeartbeatIntervalMs = Clamp(config.HeartbeatIntervalMs, 100, 2000);
            config.SoftDriftThresholdMs = Clamp(config.SoftDriftThresholdMs, 40, 1000);
            config.HardDriftThresholdMs = Clamp(config.HardDriftThresholdMs, config.SoftDriftThresholdMs + 20, 5000);
            config.ReadyBufferSeconds = Clamp(config.ReadyBufferSeconds, 1, 15);
            config.MaxMembersPerRoom = Clamp(config.MaxMembersPerRoom, 2, 100);
            config.EmptyRoomTimeoutMinutes = Clamp(config.EmptyRoomTimeoutMinutes, 1, 240);
            return config;
        }

        private static int Clamp(int value, int minimum, int maximum)
        {
            return Math.Max(minimum, Math.Min(maximum, value));
        }
    }
}
