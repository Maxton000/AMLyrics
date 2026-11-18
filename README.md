# HomoLyrics for Windows

Windows 桌面歌词播放器。读取系统 SMTC（System Media Transport Controls）的播放信息，
用 [AMLL](https://github.com/Steve-xmh/applemusic-like-lyrics)（Apple Music Like Lyrics）
渲染逐字歌词，界面参考鸿蒙平板时钟的音乐页布局。

- 不需要任何音乐平台账号，也不读取任何平台的私有接口，播放状态全部来自系统 SMTC。
- 封面与歌曲元数据通过公开接口联网匹配（网易云 → QQ 音乐降级），只做展示。

当前版本：**1.2.0**

## 功能

- **系统级播放接入**：任意支持 SMTC 的播放器（网易云、QQ 音乐、Spotify、浏览器等）都能驱动界面。
- **进度插值**：部分播放器不上报稳定进度，界面按播放状态本地推进并在系统上报新位置时重新对齐。
- **联网封面匹配**：歌名 / 歌手 / 时长打分匹配，取 500×500 封面。
- **多源歌词**：网易云 → QQ 音乐 → 酷狗音乐，优先级可在「更多」面板中上下调整，配置持久化。
- **逐字歌词 + 翻译 + 罗马音**：LRC 与翻译按时间戳合并为 TTML（`x-translation`），由 AMLL 渲染。
- **时钟**：跟随封面位置，打开歌词页后依然显示；右键可隐藏，在「更多 → 显示时钟」恢复。
- **可调项**：歌词字体大小（6 档）、歌词偏移（±10s）、时钟秒数显示。
- **无边框窗口**：拖动标题区移动窗口、右上角悬停滑出关闭 / 最小化按钮。

## 环境要求

| 用途 | 要求 |
| --- | --- |
| 运行 | Windows 10 1809+ / Windows 11，x64 |
| 构建前端 | Node.js 18+ |
| 构建 SMTC helper | .NET 8 SDK |
| 打包成 exe | 同上 + electron-builder |

## 构建

```bash
npm install

# 1) 前端：renderer/src → renderer/amll.bundle.js
npm run build:web

# 2) SMTC helper：C# 单文件自包含发布 → smtc-helper/publish/SmtcBridge.exe
npm run build:helper

# 3) 打包（NSIS 安装版 + 单文件便携版）
npm run dist
```

国内网络建议加镜像环境变量，否则 electron-builder 下载二进制会超时：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

开发模式（改前端后热重启）：

```bash
npm start
```

## 目录结构

```
electron/
  main.cjs              主进程：窗口、SMTC helper 子进程、歌词与封面匹配调度、IPC
  preload.cjs           contextBridge 暴露的 native 接口
  lyric-provider.cjs    网易云 / QQ / 酷狗 歌词抓取与优先级
  song-info-provider.cjs 歌曲元数据与封面匹配（打分制）
  ttml-builder.cjs      LRC + 翻译 → 带 x-translation 的 TTML
renderer/
  src/index.tsx         全部界面逻辑（播放状态、时钟、歌词页、更多面板）
  src/style.css         样式
  src/bridge.ts         与 preload 对应的类型化封装
  src/index.html        页面骨架
smtc-helper/SmtcBridge/
  Program.cs            stdin/stdout JSON 协议，轮询 SMTC 会话并推送快照
build-web.mjs           esbuild 打包脚本
build/icon.ico          应用图标
```

## 已知限制

- 部分播放器（如网易云桌面端）不通过 SMTC 提供封面，缩略图只能靠联网匹配。
- 音量控制不可用：SMTC 没有写音量的标准接口，界面未提供音量条。
- **便携版（单文件 exe）每次启动会把 400MB+ 的运行时解压到临时目录，冷启动约 7 秒**。
  想要快速启动请用安装版（约 0.5 秒）或解压即用的绿色版。
- 仅支持 Windows；helper 依赖 Windows.Media.Control。

## 许可

本项目**原创代码**采用 [Apache License 2.0](./LICENSE)。

但歌词渲染依赖 **AMLL（AGPL-3.0-only）**，分发可执行产物时整体需按 AGPL-3.0 提供
完整对应源码。第三方组件清单与合规说明见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)，
归属声明见 [NOTICE](./NOTICE)。
