using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Emby.SyncPlay
{
    public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        public static Plugin Instance { get; private set; }

        public override string Name => "SyncPlay";

        public override string Description => "Low-latency synchronized playback rooms for Emby Web.";

        public override Guid Id => new Guid("9f471fa8-e0c8-46de-981a-095eef98da29");

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "syncplayconfig",
                    EmbeddedResourcePath = "Emby.SyncPlay.Web.config.html"
                },
                new PluginPageInfo
                {
                    Name = "syncplayconfigjs",
                    EmbeddedResourcePath = "Emby.SyncPlay.Web.config.js"
                },
                new PluginPageInfo
                {
                    Name = "syncplayclient",
                    EmbeddedResourcePath = "Emby.SyncPlay.Web.client.js"
                },
                new PluginPageInfo
                {
                    Name = "syncplayclientcss",
                    EmbeddedResourcePath = "Emby.SyncPlay.Web.client.css"
                }
            };
        }
    }
}
