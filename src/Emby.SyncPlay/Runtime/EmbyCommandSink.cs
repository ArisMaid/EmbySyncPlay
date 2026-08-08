using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Emby.SyncPlay.Core;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Session;

namespace Emby.SyncPlay.Runtime
{
    internal sealed class EmbyCommandSink : ISyncPlayCommandSink
    {
        private readonly ISessionManager _sessionManager;
        private readonly ILogger _logger;

        public EmbyCommandSink(ISessionManager sessionManager, ILogger logger)
        {
            _sessionManager = sessionManager;
            _logger = logger;
        }

        public async Task SendAsync(
            string sessionId,
            string messageName,
            object data,
            CancellationToken cancellationToken)
        {
            var command = data as SyncPlayCommand;
            var fallbackRequired = false;
            try
            {
                var session = _sessionManager.Sessions.FirstOrDefault(item =>
                    item != null && string.Equals(item.Id, sessionId, StringComparison.OrdinalIgnoreCase));
                var controllers = session?.SessionControllers?
                    .Where(controller => controller != null && controller.IsSessionActive && controller.SupportsMediaControl)
                    .OrderByDescending(controller => controller.Priority)
                    .ToArray();

                if (controllers == null || controllers.Length == 0)
                {
                    fallbackRequired = true;
                    if (command != null && string.Equals(command.Kind, "Load", StringComparison.OrdinalIgnoreCase))
                    {
                        await _sessionManager.SendPlayCommand(
                                null,
                                sessionId,
                                new PlayRequest
                                {
                                    ItemIds = new[] { command.ItemId },
                                    StartPositionTicks = command.PositionTicks,
                                    PlayCommand = PlayCommand.PlayNow
                                },
                                cancellationToken)
                            .ConfigureAwait(false);
                    }
                }
                else
                {
                    var messageId = command?.EventId ?? Guid.NewGuid().ToString("N");
                    var sendTask = Task.WhenAll(controllers.Select(controller =>
                        controller.SendMessage(messageName, messageId, data, cancellationToken)));
                    var completed = await Task.WhenAny(
                            sendTask,
                            Task.Delay(TimeSpan.FromSeconds(2), cancellationToken))
                        .ConfigureAwait(false);
                    if (completed != sendTask)
                    {
                        fallbackRequired = true;
                        _logger.Info("[SyncPlay] Timed out sending " + messageName +
                            " to session " + sessionId + "; using media-control fallback.");
                    }
                    else
                    {
                        await sendTask.ConfigureAwait(false);
                    }
                }
            }
            catch (Exception exception)
            {
                _logger.ErrorException("[SyncPlay] Failed to send " + messageName + " to session " + sessionId, exception);
                fallbackRequired = true;
            }

            if (fallbackRequired)
            {
                try
                {
                    await SendFallbackAsync(sessionId, command, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    _logger.ErrorException("[SyncPlay] Media-control fallback failed for session " + sessionId, exception);
                }
            }
        }

        private Task SendFallbackAsync(
            string sessionId,
            SyncPlayCommand command,
            CancellationToken cancellationToken)
        {
            if (command == null)
            {
                return Task.CompletedTask;
            }

            PlaystateRequest request = null;
            switch (command.Kind)
            {
                case "Pause":
                case "Hold":
                    request = new PlaystateRequest { Command = PlaystateCommand.Pause };
                    break;
                case "Play":
                case "Resume":
                    request = new PlaystateRequest { Command = PlaystateCommand.Unpause };
                    break;
                case "Seek":
                case "Correct":
                    request = new PlaystateRequest
                    {
                        Command = PlaystateCommand.Seek,
                        SeekPositionTicks = command.PositionTicks
                    };
                    break;
            }

            return request == null
                ? Task.CompletedTask
                : _sessionManager.SendPlaystateCommand(null, sessionId, request, cancellationToken);
        }
    }
}
