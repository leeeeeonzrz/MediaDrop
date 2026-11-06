# MediaDrop 1.3.1-windows.3 Windows x64 验证记录

日期：2026-11-06。验证使用项目内独立用户目录，不覆盖已安装应用或其配置。安装包从 NSIS 中解压后运行，未执行覆盖安装。

## 来源与组件

- 应用上游仍为 `fe7fbaef4469ff65478267a44f91049506c1ad7d`（V1.3.1），已包含在 Windows 维护分支中。
- 标准 yt-dlp：官方稳定版 `2026.10.26`。
- SABR 增强引擎：`2026.10.27.135913`；官方 Windows ZIP SHA-256 为 `ad98d4a8ead8895faa5b4d3bf0bd91b94f6e0d68592a37e1b993fbc23c50ea5f`。
- 配套 bgutil 插件与令牌服务：`2.0.2`；随应用维护。切换 SABR 时不替换这些组件或标准 yt-dlp。

## 功能验证

| 检查 | 结果 |
| --- | --- |
| 后端测试 | 183 项：181 通过，2 项 Windows 符号链接权限跳过 |
| 前端与 Electron | 全部现有回归脚本通过；新增 9 项增强引擎设置行为检查通过 |
| 真实增强版本安装 | 设置页获取当前 SABR、下载、官方哈希验证、原生兼容性探测和启用成功 |
| 切换和恢复 | 恢复内置版、重新选中本机已保存版本成功；标准引擎版本与路径不变 |
| 运行中保护 | 实际解析期间切换返回 409，解析正常完成；自动测试覆盖下载、队列、暂停、重试及下载完成后激活的竞争条件 |
| 下载和字幕 | 选中独立安装的 SABR 后，增强与标准模式均完成公开视频音视频下载；独立 SRT、VTT、ASS 下载成功 |
| 本地烧录 | SRT → MP4/MKV/WebM，ASS/VTT → MP4 共 5 次成功；MP4/MKV 使用 NVIDIA NVENC，WebM 使用 CPU；原视频 SHA-256 不变 |
| 标准引擎选择 | 稳定版与夜间版各显示 30 个历史版本；明确安装较旧的 `2026.07.04` 后实际使用该版本 |
| 重启 | 从最终安装包解压出的程序启动，保留增强版本、标准历史版本和 10 条任务记录（含 5 条本地烧录） |
| 故障恢复 | 仅对隔离配置的增强引擎模拟文件损坏；启动后回退内置版并提示，标准引擎和任务历史保留；测试文件已恢复 |
| 离线与兼容性 | 原生引擎离线恢复、再选择通过；自动测试覆盖不兼容、校验失败、登记失败、应用配套组件变化与安全解压 |

最终安装包：`dist/V1.3.1-windows.3/MediaDrop Setup 1.3.1-windows.3.exe`。

- 文件大小：299,115,617 字节。
- SHA-256：`bded975e9d1b82428071177e87198e805fa2816ba98f408bc5b62e537bb0b69e`。
- `7z t` 通过；解压得到 6,485 个文件、979,555,824 字节，与 `win-unpacked` 全部文件逐项哈希一致，无用户配置、下载文件或版本登记混入。

## 范围与限制

- SABR 上游仅提供滚动的当前版本；选择器提供内置版、上游当前版、本机已保存版，不声称提供完整在线历史档案。本次远端版与内置版版本号相同，但安装位置独立，确实执行下载、探测和切换。未伪造旧版本记录。
- 未知未来版本必须通过校验和配套插件兼容性探测才能启用；这些检查无法保证所有网站和未来媒体格式都可用。失败保留原版本，已安装版本可回退。
- 本机实测范围是 Windows x64；未执行 ARM64 或 macOS 打包验证，也未完成对所有网站、视频分辨率和 HDR 素材的穷举测试。
- 服务端沿用官方 `2.0.2` 依赖锁文件。`npm audit --omit=dev` 报告 5 项传递依赖告警（3 高、2 中）；未完成应用路径可达性分析，也未通过强制升级更改官方配套组合。这份记录是功能回归记录，不是安全审计通过证明。

## 本机证据

- `build/enhanced-selector-tests/backend.log`、`native-install-results.json`
- `build/validate-v1.3.1-windows.3/desktop-results.json`、`enhanced-results.json`
- 同目录的 `media-results.json`、`youtube-results.json`、`subtitle-results.json`、`version-results.json`
- 同目录的 `restart-results.json`、`fallback-results.json`、`staging-audit.json`、`final-artifact-audit.json`
- `build/engines-20261106/provider-audit.json`

上述运行日志和测试素材位于忽略目录中；发布目录另附 `SHA256SUMS.txt` 与 `VALIDATION.json` 摘要。
