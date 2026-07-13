using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Serialization;
using Emby.SyncPlay.Core;

namespace Emby.SyncPlay.Runtime
{
    internal static class SyncPlayRuntime
    {
        public static RoomManager Rooms { get; set; }

        public static ISessionManager Sessions { get; set; }

        public static IAuthorizationContext Authorization { get; set; }

        public static IJsonSerializer Json { get; set; }

        public static ILogger Logger { get; set; }

        public static bool IsReady => Rooms != null && Sessions != null && Authorization != null;
    }
}

