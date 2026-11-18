# 第三方组件与许可（Third-Party Notices）

本项目**原创代码**使用 Apache License 2.0。下列第三方组件各自保留其原有许可，
不受本仓库 LICENSE 影响。

## 运行时依赖（会被打包进产物）

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| @applemusic-like-lyrics/core | ^0.5.2 | **AGPL-3.0-only** | 逐字歌词渲染核心 |
| @applemusic-like-lyrics/react | ^0.5.2 | **AGPL-3.0-only** | React 封装 |
| @applemusic-like-lyrics/lyric | ^1.0.2 | **AGPL-3.0-only** | 歌词解析 |
| @applemusic-like-lyrics/ttml | ^1.0.1 | **AGPL-3.0-only** | TTML 构建 |
| @fortawesome/fontawesome-free | ^7.3.1 | CC-BY-4.0（图标）/ OFL-1.1（字体）/ MIT（代码） | 界面图标 |
| react / react-dom | ^19.2.0 | MIT | 界面框架 |
| Electron | ^45.3.3 | MIT | 运行时 |
| .NET 运行时（随 SmtcBridge 单文件发布） | 8.x | MIT | SMTC 读取 helper |

## 构建期依赖

esbuild（MIT）、electron-builder（MIT）、TypeScript（Apache-2.0）。

## 关于 AGPL-3.0 的合规提示

AMLL 组件为 **AGPL-3.0-only**。AGPL-3.0 与 Apache-2.0 对「组合作品」的分发要求不同：

- **只分发源码**：本仓库的原创代码按 Apache-2.0 授权，AMLL 部分仍按 AGPL-3.0 授权，
  两者分别标注即可。
- **分发可执行产物**（安装包 / 便携版 / 解压目录）：由于产物链接了 AMLL，
  整体应按 **AGPL-3.0** 分发，并向接收者提供完整对应源码（含本仓库源码与构建脚本）。

如果你希望仓库整体只使用 Apache-2.0，需要先移除或替换 AMLL 依赖——目前歌词渲染
完全依赖 AMLL，移除即等于重写渲染层。

各组件完整许可文本见其 npm 包内 LICENSE 文件，或访问：
- AMLL：https://github.com/Steve-xmh/applemusic-like-lyrics
- Font Awesome Free：https://fontawesome.com/license/free
- Electron：https://github.com/electron/electron/blob/main/LICENSE
- React：https://github.com/facebook/react/blob/main/LICENSE
