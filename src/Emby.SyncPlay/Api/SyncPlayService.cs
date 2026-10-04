using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Emby.SyncPlay.Core;
using Emby.SyncPlay.Runtime;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Services;

namespace Emby.SyncPlay.Api
{
    [Route("/SyncPlay/Rooms", "POST")]
    public sealed class CreateRoomRequest : IReturn<JoinRoomResult>
    {
        public string Name { get; set; }

        public long? PositionTicks { get; set; }

        public bool? IsPaused { get; set; }
    }

    [Route("/SyncPlay/Rooms/{Code}", "GET")]
    public sealed class GetRoomRequest : IReturn<RoomDto>
    {
        public string Code { get; set; }
    }

    [Route("/SyncPlay/Rooms/{Code}/Join", "POST")]
    public sealed class JoinRoomRequest : IReturn<JoinRoomResult>
    {
        public string Code { get; set; }
    }

    [Route("/SyncPlay/Rooms/Leave", "POST")]
    public sealed class LeaveRoomRequest : IReturn<bool>
    {
    }

    [Route("/SyncPlay/Rooms/{Code}", "DELETE")]
    public sealed class CloseRoomRequest : IReturn<bool>
    {
        public string Code { get; set; }
    }

    [Route("/SyncPlay/Status", "GET")]
    public sealed class GetSyncPlayStatusRequest : IReturn<JoinRoomResult>
    {
    }

    [Route("/SyncPlay/Events", "POST")]
    public sealed class PostSyncPlayEventRequest : IReturn<SyncPlayEventResult>
    {
        public string MessageType { get; set; }

        public SyncPlaySocketEnvelope Data { get; set; }
    }

    [Route("/SyncPlay/Client.js", "GET")]
    [Unauthenticated]
    public sealed class GetSyncPlayClientRequest : IReturn<Stream>
    {
    }

    [Route("/SyncPlay/Client.css", "GET")]
    [Unauthenticated]
    public sealed class GetSyncPlayCssRequest : IReturn<Stream>
    {
    }

    [Authenticated]
    public sealed class SyncPlayService : IService, IRequiresRequest
    {
        public IRequest Request { get; set; }

        public object Post(CreateRoomRequest request)
        {
            EnsureReady();
            var session = GetCurrentSession();
            var nowPlaying = session.NowPlayingItem;
            if (nowPlaying == null || !long.TryParse(nowPlaying.Id, out var itemId))
            {
                throw new InvalidOperationException("请先播放一个视频，再创建同步房间。");
            }

            var playState = session.PlayState;
            return SyncPlayRuntime.Rooms.CreateRoom(
                ToDescriptor(session),
                itemId,
                nowPlaying.Name,
                request?.PositionTicks ?? playState?.PositionTicks ?? 0,
                request?.IsPaused ?? playState?.IsPaused ?? false,
                request?.Name);
        }

        public object Get(GetRoomRequest request)
        {
            EnsureReady();
            var session = GetCurrentSession();
            var room = SyncPlayRuntime.Rooms.GetRoom(request.Code, session.Id);
            if (room == null)
            {
                throw new ArgumentException("房间不存在或已经关闭。");
            }

            return room;
        }

        public async Task<object> Post(JoinRoomRequest request)
        {
            EnsureReady();
            var session = GetCurrentSession();
            return await SyncPlayRuntime.Rooms.JoinRoomAsync(
                    request.Code,
                    ToDescriptor(session),
                    CancellationToken.None)
                .ConfigureAwait(false);
        }

        public object Post(LeaveRoomRequest request)
        {
            EnsureReady();
            return SyncPlayRuntime.Rooms.LeaveRoom(GetCurrentSession().Id);
        }

        public object Delete(CloseRoomRequest request)
        {
            EnsureReady();
            return SyncPlayRuntime.Rooms.CloseRoom(request.Code, GetCurrentSession().Id, false);
        }

        public object Get(GetSyncPlayStatusRequest request)
        {
            EnsureReady();
            return SyncPlayRuntime.Rooms.GetStatus(GetCurrentSession().Id);
        }

        public async Task<object> Post(PostSyncPlayEventRequest request)
        {
            EnsureReady();
            if (request == null || string.IsNullOrWhiteSpace(request.MessageType) || request.Data == null)
            {
                throw new ArgumentException("Invalid SyncPlay event.");
            }

            var session = GetCurrentSession();
            var serverReceiveUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // During a media transition Emby can still expose the previous
            // NowPlayingItem while the browser is already loading the new
            // item. Preserve the client's epoch/item stamp when it has one;
            // only fill a missing stamp from the session as a compatibility
            // fallback for older clients.
            if (request.Data.ItemId <= 0 && session.NowPlayingItem != null &&
                long.TryParse(session.NowPlayingItem.Id, out var currentItemId))
            {
                request.Data.ItemId = currentItemId;
            }

            var accepted = await SyncPlayRuntime.Rooms.ProcessSocketMessageAsync(
                    request.MessageType,
                    request.Data,
                    CancellationToken.None)
                .ConfigureAwait(false);
            var roomStatus = SyncPlayRuntime.Rooms.GetStatus(session.Id);
            return new SyncPlayEventResult
            {
                Accepted = accepted && roomStatus != null,
                ServerReceiveUnixMs = serverReceiveUnixMs,
                ServerSendUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Room = roomStatus?.Room
            };
        }

        private SessionInfo GetCurrentSession()
        {
            var authorization = SyncPlayRuntime.Authorization.GetAuthorizationInfo(Request);
            if (authorization == null)
            {
                throw new UnauthorizedAccessException("Emby authentication is required.");
            }

            var session = SyncPlayRuntime.Sessions.Sessions.FirstOrDefault(item =>
                item != null && item.InternalDeviceId == authorization.DeviceId);
            if (session == null)
            {
                throw new InvalidOperationException("找不到当前浏览器对应的 Emby 播放会话，请刷新播放器后重试。");
            }

            return session;
        }

        private static SessionDescriptor ToDescriptor(SessionInfo session)
        {
            return new SessionDescriptor
            {
                SessionId = session.Id,
                UserId = session.UserId,
                UserName = session.UserName,
                DeviceName = session.DeviceName
            };
        }

        private static void EnsureReady()
        {
            if (!SyncPlayRuntime.IsReady)
            {
                throw new InvalidOperationException("SyncPlay is still starting. Please retry in a moment.");
            }
        }
    }

    [Unauthenticated]
    public sealed class SyncPlayAssetService : IService, IRequiresRequest
    {
        public IRequest Request { get; set; }

        public Stream Get(GetSyncPlayClientRequest request)
        {
            Request.Response.ContentType = "application/javascript; charset=utf-8";
            return GetResource("Emby.SyncPlay.Web.client.js");
        }

        public Stream Get(GetSyncPlayCssRequest request)
        {
            Request.Response.ContentType = "text/css; charset=utf-8";
            return GetResource("Emby.SyncPlay.Web.client.css");
        }

        private static Stream GetResource(string name)
        {
            return typeof(Plugin).GetTypeInfo().Assembly.GetManifestResourceStream(name) ?? Stream.Null;
        }
    }
}
