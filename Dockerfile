FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /source

COPY Directory.Build.props SyncPlay.sln ./
COPY src/Emby.SyncPlay/Emby.SyncPlay.csproj src/Emby.SyncPlay/
COPY tests/Emby.SyncPlay.Tests/Emby.SyncPlay.Tests.csproj tests/Emby.SyncPlay.Tests/
RUN dotnet restore SyncPlay.sln

COPY src src
COPY tests tests
RUN dotnet test SyncPlay.sln -c Release --no-restore --nologo
RUN dotnet publish src/Emby.SyncPlay/Emby.SyncPlay.csproj -c Release --no-restore -o /out

FROM amilys/embyserver:4.9.3.0
COPY --from=build /out/Emby.SyncPlay.dll /system/plugins/Emby.SyncPlay.dll
COPY docker/syncplay-loader.js /system/dashboard-ui/syncplay-loader-1.5.5.js
COPY docker/syncplay-init.sh /usr/local/bin/syncplay-init

# amilys/embyserver exposes a RequireJS extension array in dashboard-ui/ext.js.
# Add the plugin asset endpoint without replacing any extensions already configured.
RUN sed -i '1a extmod.push("syncplay-loader-1.5.5");' /system/dashboard-ui/ext.js
RUN chmod 755 /usr/local/bin/syncplay-init

ENTRYPOINT ["/usr/local/bin/syncplay-init"]

LABEL org.opencontainers.image.title="Emby SyncPlay" \
      org.opencontainers.image.description="Low-latency synchronized playback rooms for Emby Web" \
      org.opencontainers.image.version="1.5.5"
