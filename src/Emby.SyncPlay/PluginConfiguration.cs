using MediaBrowser.Model.Plugins;

namespace Emby.SyncPlay
{
    public sealed class PluginConfiguration : BasePluginConfiguration
    {
        public int HeartbeatIntervalMs { get; set; } = 250;

        public int SoftDriftThresholdMs { get; set; } = 80;

        public int HardDriftThresholdMs { get; set; } = 500;

        public int ReadyBufferSeconds { get; set; } = 2;

        public int ReconnectGraceSeconds { get; set; } = 5;

        public int EmptyRoomTimeoutMinutes { get; set; } = 10;

        public int MaxMembersPerRoom { get; set; } = 20;

        public bool EnableDebugLogging { get; set; }
    }
}

