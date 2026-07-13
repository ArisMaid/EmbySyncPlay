#!/bin/sh
set -eu

mkdir -p /config/plugins
cp -f /system/plugins/Emby.SyncPlay.dll /config/plugins/Emby.SyncPlay.dll

exec /init "$@"
