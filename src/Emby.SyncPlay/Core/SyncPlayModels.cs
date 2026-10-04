using System;
using System.Collections.Generic;

namespace Emby.SyncPlay.Core
{
    public enum RoomPlaybackState
    {
        Playing,
        Paused,
        Holding
    }

    public enum MediaTransitionState
    {
        None,
        AwaitingHostPlayback,
        LoadingMembers
    }

    public enum SyncControlKind
    {
        Play,
        Pause,
        Seek,
        Stop
    }

    public sealed class SyncPlayMember
    {
        public string SessionId { get; set; }
        public string UserId { get; set; }
        public string UserName { get; set; }
        public string DeviceName { get; set; }
        public string Token { get; set; }
        public string ClientInstanceId { get; set; }
        public HashSet<string> RetiredClientInstances { get; } = new HashSet<string>(StringComparer.Ordinal);
        public long LastClientSequence { get; set; }
        public long LastHeartbeatUnixMs { get; set; }
        public long PositionTicks { get; set; }
        public bool IsPaused { get; set; }
        public bool IsBuffering { get; set; }
        public bool IsReady { get; set; }
        public bool IsActive { get; set; }
        public bool IsMediaLoading { get; set; }
        public bool IsMediaReady { get; set; }
        public bool MediaLoadTimedOut { get; set; }
        public long MediaEpoch { get; set; }
        public long CurrentItemId { get; set; }
        public string PlaySessionId { get; set; }
        public int RoundTripTimeMs { get; set; }
        public int DriftMs { get; set; }
        public DateTimeOffset JoinedAt { get; set; }
    }

    public sealed class SyncPlayRoom
    {
        public SyncPlayRoom()
        {
            Members = new Dictionary<string, SyncPlayMember>(StringComparer.OrdinalIgnoreCase);
            Gate = new object();
        }

        public string Code { get; set; }
        public string Name { get; set; }
        public string CreatorSessionId { get; set; }
        public long ItemId { get; set; }
        public string ItemName { get; set; }
        public long PositionTicks { get; set; }
        public long ReferenceUnixMs { get; set; }
        public RoomPlaybackState State { get; set; }
        public RoomPlaybackState StateBeforeHold { get; set; }
        public long Revision { get; set; }
        public long MediaEpoch { get; set; }
        public MediaTransitionState MediaTransitionState { get; set; }
        public long TransitionDeadlineUnixMs { get; set; }
        public long LoadRetryAtUnixMs { get; set; }
        public bool LoadRetrySent { get; set; }
        public string HoldReason { get; set; }
        public long PreviousItemId { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public DateTimeOffset LastActivityAt { get; set; }
        public Dictionary<string, SyncPlayMember> Members { get; }
        public object Gate { get; }

        public long EstimatePositionTicks(long unixMs)
        {
            if (State != RoomPlaybackState.Playing)
            {
                return PositionTicks;
            }

            var elapsedMs = Math.Max(0, unixMs - ReferenceUnixMs);
            return PositionTicks + (elapsedMs * TimeSpan.TicksPerMillisecond);
        }
    }

    public sealed class RoomMemberDto
    {
        public string Name { get; set; }
        public string Device { get; set; }
        public bool IsCreator { get; set; }
        public bool IsBuffering { get; set; }
        public bool IsReady { get; set; }
        public bool IsActive { get; set; }
        public bool IsMediaLoading { get; set; }
        public bool IsMediaReady { get; set; }
        public bool MediaLoadTimedOut { get; set; }
        public int RoundTripTimeMs { get; set; }
        public int DriftMs { get; set; }
    }

    public sealed class RoomDto
    {
        public string Code { get; set; }
        public string Name { get; set; }
        public long ItemId { get; set; }
        public string ItemName { get; set; }
        public string State { get; set; }
        public long PositionTicks { get; set; }
        public long ReferenceUnixMs { get; set; }
        public long Revision { get; set; }
        public long MediaEpoch { get; set; }
        public string MediaTransitionState { get; set; }
        public long TransitionDeadlineUnixMs { get; set; }
        public string HoldReason { get; set; }
        public int ReadyMemberCount { get; set; }
        public int LoadingMemberCount { get; set; }
        public bool IsCurrentMemberMediaLoading { get; set; }
        public bool IsCurrentMemberMediaReady { get; set; }
        public bool IsCurrentMemberActive { get; set; }
        public bool IsCreator { get; set; }
        public int MemberCount { get; set; }
        public List<RoomMemberDto> Members { get; set; }
    }

    public sealed class JoinRoomResult
    {
        public RoomDto Room { get; set; }
        public string MemberToken { get; set; }
        public int HeartbeatIntervalMs { get; set; }
        public int SoftDriftThresholdMs { get; set; }
        public int HardDriftThresholdMs { get; set; }
        public int ReadyBufferSeconds { get; set; }
    }

    public sealed class SyncPlaySocketEnvelope
    {
        public string MemberToken { get; set; }
        public string RoomCode { get; set; }
        public string ClientInstanceId { get; set; }
        public long ClientSequence { get; set; }
        public string EventId { get; set; }
        public string Kind { get; set; }
        public long PositionTicks { get; set; }
        public bool IsPaused { get; set; }
        public bool IsBuffering { get; set; }
        public bool IsReady { get; set; }
        public bool IsActive { get; set; }
        public int RoundTripTimeMs { get; set; }
        public long ClientUnixMs { get; set; }
        public long ClientMonotonicMs { get; set; }
        public long MediaEpoch { get; set; }
        public long ItemId { get; set; }
        public string PlaySessionId { get; set; }
    }

    public sealed class SyncPlayCommand
    {
        public string EventId { get; set; }
        public string Kind { get; set; }
        public long RoomRevision { get; set; }
        public long MediaEpoch { get; set; }
        public long ItemId { get; set; }
        public string ItemName { get; set; }
        public long PositionTicks { get; set; }
        public long ReferenceUnixMs { get; set; }
        public long ExecuteAtUnixMs { get; set; }
        public string State { get; set; }
        public string SourceSessionId { get; set; }
        public string Reason { get; set; }
    }

    public sealed class ClockPong
    {
        public string EventId { get; set; }
        public long ClientUnixMs { get; set; }
        public long ServerReceiveUnixMs { get; set; }
        public long ServerSendUnixMs { get; set; }
    }

    public sealed class SyncPlayEventResult
    {
        public bool Accepted { get; set; }
        public long ServerReceiveUnixMs { get; set; }
        public long ServerSendUnixMs { get; set; }
        public RoomDto Room { get; set; }
    }

    public sealed class SessionDescriptor
    {
        public string SessionId { get; set; }
        public string UserId { get; set; }
        public string UserName { get; set; }
        public string DeviceName { get; set; }
    }

    public sealed class PlaybackTransitionResult
    {
        public bool Handled { get; set; }
        public bool MembershipEnded { get; set; }
        public bool RoomClosed { get; set; }
        public string Reason { get; set; }
        public long MediaEpoch { get; set; }
    }

    public sealed class MediaTransitionTickResult
    {
        public int RoomsClosed { get; set; }
        public int LoadsRetried { get; set; }
        public int LoadingBarriersReleased { get; set; }
    }
}
