using System;

namespace Emby.SyncPlay.Core
{
    public interface ISyncPlayClock
    {
        DateTimeOffset UtcNow { get; }

        long UnixTimeMilliseconds { get; }
    }

    public sealed class SystemSyncPlayClock : ISyncPlayClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public long UnixTimeMilliseconds => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}

