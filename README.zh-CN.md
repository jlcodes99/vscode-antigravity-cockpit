# Antigravity Cockpit 🚀

> 在 VS Code 中以仪表盘方式监控 Google Antigravity AI 配额。

简体中文 · [英文](README.md)

[![版本](https://img.shields.io/open-vsx/v/jlcodes/antigravity-cockpit)](https://open-vsx.org/extension/jlcodes/antigravity-cockpit)
[![GitHub Stars](https://img.shields.io/github/stars/jlcodes99/vscode-antigravity-cockpit?style=flat&color=gold)](https://github.com/jlcodes99/vscode-antigravity-cockpit)
[![GitHub Issues](https://img.shields.io/github/issues/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit/issues)
[![许可证](https://img.shields.io/github/license/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit)

**Antigravity Cockpit** 提供一个赛博朋克风格的 HUD 仪表盘，用来监控 AI 模型配额，让你不再猜测配额何时重置。

![Antigravity Cockpit Dashboard](assets/dashboard_preview.png)

---

## 功能特性

### 沉浸式仪表盘
使用深色主题的 Webview，把所有模型（例如 Gemini 3 Pro (High)、Claude Sonnet 4.5、GPT-OSS 120B (Medium) 等）以实时仪表方式展示。

### 精确定时
同时显示倒计时（例如 `4h 40m`）和精确的重置时间戳（例如 `15:16:25`），让你知道什么时候可以继续使用。

### 交互式控制
- 拖拽排序：按你的习惯重新排列模型卡片，布局会自动保存。
- 固定到状态栏：在模型卡片上直接切换是否显示在状态栏。
- 一键刷新：点击刷新按钮立即拉取数据（120 秒冷却）。

### 智能状态栏
- 并排显示你固定的模型（例如 `🚀 Gemini 3 Pro (High): 100% | Claude Sonnet 4.5: 86%`）。
- 如果没有固定任何模型，会自动监控“剩余配额最低”的模型，减少踩线风险。
- 支持多种显示格式：精简、标准、详细。

### 通知提醒
- 当模型配额耗尽或低配额（< 30%）时弹出通知。
- 可在设置中关闭通知，保持安静。

### 多语言支持
- 支持英文与中文。
- 自动根据 VS Code 语言设置切换。

### 稳定且快速
- 即时恢复：仪表盘状态会缓存，即使切到后台也能快速恢复。
- 零配置：自动检测本地 Antigravity 进程，无需手动设置。
- 主题自适配：自动跟随浅色/深色主题。

---

## 使用方法

1. 打开：
   - 点击状态栏中的 `$(rocket) Cockpit`

2. 自定义：
   - 固定：在模型卡片上切换开关，决定是否显示在状态栏。
   - 排序：拖拽卡片调整顺序（拖拽手柄通常显示为 ⋮⋮）。
   - 积分：如果你需要查看 Prompt Credits，可以在右上角开启 “Show Prompt Credits”。

3. 故障排查：
   - 如果仪表盘显示 “Systems Offline”，点击 “Retry Connection”。
   - 点击 “Open Logs” 查看更详细的调试日志。

---

## 配置

我们更推荐“在 UI 中交互式配置”。排序、固定、可见性等主要偏好都可以直接在仪表盘里完成。

### 可用设置

| 设置项 | 默认值 | 说明 |
|---------|---------|-------------|
| `agCockpit.refreshInterval` | `120` | 轮询频率（秒，10-3600） |
| `agCockpit.showPromptCredits` | `false` | 在仪表盘中显示 Prompt Credits |
| `agCockpit.pinnedModels` | `[]` | 状态栏固定显示的模型 |
| `agCockpit.logLevel` | `info` | 日志级别：debug / info / warn / error |
| `agCockpit.notificationEnabled` | `true` | 是否启用配额通知 |
| `agCockpit.statusBarFormat` | `standard` | 显示格式：compact / standard / detailed |

### `settings.json` 示例

```json
{
  "agCockpit.refreshInterval": 120,
  "agCockpit.showPromptCredits": true,
  "agCockpit.pinnedModels": ["Gemini 3 Pro (High)", "Claude Sonnet 4.5"],
  "agCockpit.statusBarFormat": "detailed",
  "agCockpit.logLevel": "debug"
}
```

---

## 安装

### 方法 1：通过 Open VSX（推荐）

1. 打开编辑器（VSCodium / Code - OSS 等）
2. 按 `Cmd+Shift+X`（macOS）/ `Ctrl+Shift+X`（Windows/Linux）打开扩展面板
3. 搜索 `Antigravity Cockpit` 或 `antigravity-cockpit`
4. 点击安装

### 方法 2：通过 VSIX（命令行）

```bash
code --install-extension antigravity-cockpit-x.y.z.vsix
```

### 方法 3：通过 VSIX（拖拽）

1. 下载或自行构建 `.vsix`
2. 打开扩展面板
3. 将 `.vsix` 文件拖进扩展面板
4. 或点击 `...` → “Install from VSIX...” 选择文件安装

### 方法 4：从源码安装

见下方“从源码构建”章节。

---

## 从源码构建

### 环境要求

- Node.js v18+（建议）
- npm v9+
- VS Code v1.90+

### 步骤

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 打包（可选）
npm run package
```

---

## 更新日志

- 中文： [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)
- 英文： [CHANGELOG.md](CHANGELOG.md)

---

## 支持项目

[![GitHub stars](https://img.shields.io/github/stars/jlcodes99/vscode-antigravity-cockpit?style=social)](https://github.com/jlcodes99/vscode-antigravity-cockpit)

- ⭐ 去 GitHub 点 Star： https://github.com/jlcodes99/vscode-antigravity-cockpit
- 💬 反馈与问题： https://github.com/jlcodes99/vscode-antigravity-cockpit/issues
- 📖 Open VSX 页面： https://open-vsx.org/extension/jlcodes/antigravity-cockpit

---

## License

[MIT](LICENSE)

