# EmbySyncPlay

面向 Emby Web 的低延迟多人同步播放插件，适配 `amilys/embyserver:4.9.3.0`。

## 功能

- 3 位数字房间码，播放器 OSD 与顶栏原生风格入口
- 全员同步播放、暂停和拖动，自动校时与漂移修正
- 任一活跃成员缓冲时暂停全房，Ready 后统一恢复
- 仅房主可切换全房媒体；普通成员切换时只退出自己
- 房主选片期间保留房间，新媒体加载完成后统一开播
- WebSocket 不可用时通过 `/SyncPlay/Events` + `/SyncPlay/Status` 的 HTTP 通道继续同步

## 安装

从 [Releases](../../releases) 下载：

- `EmbySyncPlay-1.5.7-amilys.zip`：推荐安装包，包含 DLL、Web 加载器和安装说明。
- `Emby.SyncPlay.dll`：仅服务端组件，适用于已单独配置 Web 加载器的环境。

Docker 用户也可直接构建：

发布镜像（Linux amd64）：`ghcr.io/arismaid/embysyncplay:1.5.7`。
镜像基于 `amilys/embyserver:4.9.3.0`；现有服务器版本高于此版本时，不要直接降级并复用配置，优先安装插件包。

```powershell
docker compose up -d --build
```

媒体目录默认为 `./media` 和 `./strm`，可通过 `EMBY_MEDIA_PATH`、`EMBY_STRM_PATH` 修改。

如果 Emby 前置反向代理不支持 WebSocket Upgrade，插件会自动使用 HTTP fallback；仍建议透传 `/embywebsocket` 的 `Connection: Upgrade` 与 `Upgrade: websocket`，或在局域网直接访问 Emby 的 `8096` 端口。

## 构建与测试

```powershell
.\scripts\build.ps1
node --test tests/client*.test.js
```

构建产物位于 `dist/Emby.SyncPlay.dll`。

## 当前版本

`1.5.7`
