# EmbySyncPlay

面向 Emby Web 的低延迟多人同步播放插件，适配 `amilys/embyserver:4.9.3.0`。

## 功能

- 3 位数字房间码，播放器 OSD 与顶栏原生风格入口
- 全员同步播放、暂停和拖动，自动校时与漂移修正
- 任一活跃成员缓冲时暂停全房，Ready 后统一恢复
- 仅房主可切换全房媒体；普通成员切换时只退出自己
- 房主选片期间保留房间，新媒体加载完成后统一开播

## 安装

从 [Releases](../../releases) 下载：

- `Emby.SyncPlay.dll`：复制到 Emby 的插件目录并重启服务。
- `EmbySyncPlay-1.5.0-amilys.zip`：适用于 `amilys/embyserver`，包含 DLL、Web 加载器和安装说明。

Docker 用户也可直接构建：

```powershell
docker compose up -d --build
```

媒体目录默认为 `./media` 和 `./strm`，可通过 `EMBY_MEDIA_PATH`、`EMBY_STRM_PATH` 修改。

## 构建与测试

```powershell
.\scripts\build.ps1
node --test tests/client-observer.test.js
```

构建产物位于 `dist/Emby.SyncPlay.dll`。

## 当前版本

`1.5.0`
