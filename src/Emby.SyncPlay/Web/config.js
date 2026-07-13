(function () {
    "use strict";
    const pluginId = "9f471fa8-e0c8-46de-981a-095eef98da29";
    const page = document.querySelector(".syncPlayConfigurationPage");
    page.addEventListener("pageshow", function () {
        Dashboard.showLoadingMsg();
        ApiClient.getPluginConfiguration(pluginId).then(function (config) {
            ["HeartbeatIntervalMs", "SoftDriftThresholdMs", "HardDriftThresholdMs", "ReadyBufferSeconds", "MaxMembersPerRoom"].forEach(function (name) {
                page.querySelector("#" + name).value = config[name];
            });
            page.querySelector("#EnableDebugLogging").checked = config.EnableDebugLogging;
            Dashboard.hideLoadingMsg();
        });
    });
    page.querySelector(".syncPlayConfigurationForm").addEventListener("submit", function (event) {
        event.preventDefault();
        Dashboard.showLoadingMsg();
        ApiClient.getPluginConfiguration(pluginId).then(function (config) {
            ["HeartbeatIntervalMs", "SoftDriftThresholdMs", "HardDriftThresholdMs", "ReadyBufferSeconds", "MaxMembersPerRoom"].forEach(function (name) {
                config[name] = Number(page.querySelector("#" + name).value);
            });
            config.EnableDebugLogging = page.querySelector("#EnableDebugLogging").checked;
            return ApiClient.updatePluginConfiguration(pluginId, config);
        }).then(Dashboard.processPluginConfigurationUpdateResult);
        return false;
    });
})();
