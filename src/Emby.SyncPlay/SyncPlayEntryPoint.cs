using System;
using System.Threading;
using Emby.SyncPlay.Core;
using Emby.SyncPlay.Runtime;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Serialization;

namespace Emby.SyncPlay
{
    public sealed class SyncPlayEntryPoint : IServerEntryPoint
    {
        private readonly ISessionManager _sessionManager;
        private readonly ILogger _logger;
        private Timer _cleanupTimer;
        private Timer _transitionTimer;
        private int _transitionTickRunning;

        public SyncPlayEntryPoint(
            ISessionManager sessionManager,
            IAuthorizationContext authorizationContext,
            IJsonSerializer jsonSerializer,
            ILogManager logManager)
        {
            _sessionManager = sessionManager;
            _logger = logManager.GetLogger("SyncPlay");

            SyncPlayRuntime.Sessions = sessionManager;
            SyncPlayRuntime.Authorization = authorizationContext;
            SyncPlayRuntime.Json = jsonSerializer;
            SyncPlayRuntime.Logger = _logger;
            SyncPlayRuntime.Rooms = new RoomManager(
                new SystemSyncPlayClock(),
                new EmbyCommandSink(sessionManager, _logger),
                () => Plugin.Instance?.Configuration ?? new PluginConfiguration());
        }

        public void Run()
        {
            _sessionManager.PlaybackStart += OnPlaybackStarted;
            _sessionManager.PlaybackStopped += OnPlaybackStopped;
            _sessionManager.SessionEnded += OnSessionEnded;
            _cleanupTimer = new Timer(
                _ => Cleanup(),
                null,
                TimeSpan.FromMinutes(1),
                TimeSpan.FromMinutes(1));
            _transitionTimer = new Timer(
                _ => ProcessMediaTransitions(),
                null,
                TimeSpan.FromSeconds(1),
                TimeSpan.FromSeconds(1));
            _logger.Info("[SyncPlay] Low-latency room service started.");
        }

        private async void OnPlaybackStarted(object sender, PlaybackProgressEventArgs e)
        {
            if (e?.Session?.Id == null || e.Item == null)
            {
                return;
            }

            try
            {
                await SyncPlayRuntime.Rooms.HandlePlaybackStartedAsync(
                        e.Session.Id,
                        e.Item.InternalId,
                        e.Item.Name,
                        e.PlaybackPositionTicks ?? 0,
                        e.Session.PlayState?.IsPaused ?? false,
                        e.PlaySessionId,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                _logger.ErrorException("[SyncPlay] Playback start transition failed.", exception);
            }
        }

        private void OnPlaybackStopped(object sender, PlaybackStopEventArgs e)
        {
            if (e?.Session?.Id != null)
            {
                SyncPlayRuntime.Rooms?.HandlePlaybackStopped(
                    e.Session.Id,
                    e.Item?.InternalId ?? 0,
                    e.PlaySessionId,
                    e.PlayedToCompletion);
            }
        }

        private void OnSessionEnded(object sender, SessionEventArgs e)
        {
            if (e?.SessionInfo?.Id != null)
            {
                SyncPlayRuntime.Rooms?.LeaveRoom(e.SessionInfo.Id);
            }
        }

        private void Cleanup()
        {
            try
            {
                var count = SyncPlayRuntime.Rooms?.CleanupExpiredRooms() ?? 0;
                if (count > 0)
                {
                    _logger.Info("[SyncPlay] Removed " + count + " expired room(s).");
                }
            }
            catch (Exception exception)
            {
                _logger.ErrorException("[SyncPlay] Room cleanup failed.", exception);
            }
        }

        private async void ProcessMediaTransitions()
        {
            if (Interlocked.Exchange(ref _transitionTickRunning, 1) != 0)
            {
                return;
            }

            try
            {
                await SyncPlayRuntime.Rooms.ProcessMediaTransitionTimeoutsAsync(CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                _logger.ErrorException("[SyncPlay] Media transition timer failed.", exception);
            }
            finally
            {
                Interlocked.Exchange(ref _transitionTickRunning, 0);
            }
        }

        public void Dispose()
        {
            _cleanupTimer?.Dispose();
            _transitionTimer?.Dispose();
            _sessionManager.PlaybackStart -= OnPlaybackStarted;
            _sessionManager.PlaybackStopped -= OnPlaybackStopped;
            _sessionManager.SessionEnded -= OnSessionEnded;
            _logger.Info("[SyncPlay] Room service stopped.");
        }
    }
}
