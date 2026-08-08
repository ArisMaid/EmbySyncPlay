(function loadSyncPlayClient() {
    "use strict";
    if (document.querySelector('script[data-syncplay-client="true"]')) {
        return;
    }
    var script = document.createElement("script");
    script.dataset.syncplayClient = "true";
    script.src = "/web/configurationpage?name=syncplayclient&v=1.5.5";
    document.head.appendChild(script);
})();
