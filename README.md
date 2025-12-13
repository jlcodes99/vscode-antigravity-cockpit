# Antigravity Cockpit 🚀

> A futuristic dashboard for monitoring Google Antigravity AI quotas in VS Code.

[![Version](https://img.shields.io/visual-studio-marketplace/v/jlcodes.antigravity-cockpit)](https://marketplace.visualstudio.com/items?itemName=jlcodes.antigravity-cockpit)
[![GitHub stars](https://img.shields.io/github/stars/jlcodes99/vscode-antigravity-cockpit?style=flat&color=gold)](https://github.com/jlcodes99/vscode-antigravity-cockpit)
[![GitHub issues](https://img.shields.io/github/issues/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit/issues)
[![License](https://img.shields.io/github/license/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit)

**Antigravity Cockpit** transforms your coding experience with a premium, Cyberpunk-styled HUD for monitoring AI model quotas. Say goodbye to guessing when your models limits reset.

![Antigravity Cockpit Dashboard](assets/dashboard_preview.png)

---

## ✨ Features

### 🚀 Immersive Dashboard
A beautiful, dark-mode Webview visualization of all your AI models (**Gemini 3 Pro (High)**, **Claude Sonnet 4.5**, **GPT-OSS 120B (Medium)**, etc.) with real-time health gauges.

### ⏱️ Precision Timing
Know *exactly* when to get back to work. Displays both a countdown (e.g., `4h 40m`) and the absolute reset timestamp (e.g., `15:16:25`).

### 👆 Interactive Control
- **Drag & Drop**: Arrange models exactly how you want them. Your layout is saved automatically.
- **Pin to Bar**: Toggle which models appear in your VS Code status bar directly from the card.
- **One-Click Refresh**: Need data now? Hit the refresh button (120s cooldown).

### 📊 Smart Status Bar
- Shows pinned models side-by-side (e.g., `🚀 Gemini 3 Pro (High): 100% | Claude Sonnet 4.5: 86%`).
- If nothing is pinned, intelligently monitors the **lowest quota** model to keep you safe.
- Customizable display formats: compact, standard, or detailed.

### 🔔 Smart Notifications
- Get notified when a model's quota is **exhausted** or running **low** (< 30%).
- Notifications can be disabled in settings if you prefer a quiet experience.

### 🌐 Multi-language Support
- Supports **English** and **Chinese (简体中文)**.
- Automatically detects your VS Code language setting.


### 💎 Stable & Fast
- **Instant Rehydration**: Dashboard state is cached, so it loads instantly even after being backgrounded.
- **Zero-Config**: Auto-detects local Antigravity processes without manual setup.
- **VS Code Theme Integration**: Automatically adapts to your light or dark theme.

---

## 🕹️ Usage

1. **Open**: 
   - Click the **$(rocket) Cockpit** item in your status bar

2. **Customize**:
   - **Pin**: Flip the switch on a model card to see it in the status bar.
   - **Order**: Drag cards to reorder (look for the ⋮⋮ handle).
   - **Credits**: Toggle "Show Prompt Credits" at the top right if you use them.

3. **Troubleshoot**:
   - If the dashboard shows "Systems Offline", click **Retry Connection**.
   - Use the **Open Logs** button to view detailed debug information.

---

## ⚙️ Configuration

We believe in **Interactivity over Configuration**. All major preferences (Sorting, Pinning, Visibility) are managed directly via the UI.

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agCockpit.refreshInterval` | `120` | Polling frequency in seconds (10-3600) |
| `agCockpit.showPromptCredits` | `false` | Show prompt credits in dashboard |
| `agCockpit.pinnedModels` | `[]` | Models to show in status bar |
| `agCockpit.logLevel` | `info` | Log verbosity: debug, info, warn, error |
| `agCockpit.notificationEnabled` | `true` | Show quota notifications |
| `agCockpit.statusBarFormat` | `standard` | Display format: compact, standard, detailed |

### Example `settings.json`:

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

## 📦 Installation

### Method 1: From VS Code Marketplace (推荐)

1. Open VS Code
2. Press `Cmd+Shift+X` (macOS) / `Ctrl+Shift+X` (Windows/Linux) to open Extensions
3. Search for `Antigravity Cockpit`
4. Click **Install**

### Method 2: From VSIX File (命令行安装)

```bash
# Download or build the .vsix file first, then:
code --install-extension antigravity-cockpit-1.2.11.vsix
```

### Method 3: From VSIX File (拖拽安装)

1. Download or build the `.vsix` file
2. Open VS Code
3. Open Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
4. Drag the `.vsix` file into the Extensions panel
5. Or click `...` menu → **Install from VSIX...** → Select the file

### Method 4: Install from Source

See [Building from Source](#-building-from-source) below.

---

## 🔧 Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [npm](https://www.npmjs.com/) v9 or higher
- [VS Code](https://code.visualstudio.com/) v1.90 or higher

### Step 1: Clone & Install

```bash
# Clone the repository
git clone https://github.com/jlcodes99/vscode-antigravity-cockpit.git
cd vscode-antigravity-cockpit

# Install dependencies
npm install
```

### Step 2: Compile

```bash
# Compile TypeScript to JavaScript
npm run compile
```

### Step 3: Package (Optional)

```bash
# Create .vsix package file
npm run package

# This will generate: antigravity-cockpit-x.x.x.vsix
```

### Step 4: Install

**Option A: Command Line**
```bash
code --install-extension antigravity-cockpit-1.2.11.vsix
```

**Option B: Drag & Drop**
1. Open VS Code Extensions panel
2. Drag the `.vsix` file into it

**Option C: VS Code Menu**
1. Open Extensions panel
2. Click `...` menu at top-right
3. Select **Install from VSIX...**
4. Choose the `.vsix` file

### Step 5: Debug Mode (Development)

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. A new VS Code window will open with the extension loaded

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run compile` | Compile TypeScript + copy webview assets |
| `npm run watch` | Watch mode compilation |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint issues |
| `npm run package` | Create .vsix package |

---

## 📁 Project Structure

```
src/
├── extension.ts              # Extension entry point
├── engine/
│   ├── hunter.ts             # Process detection
│   ├── reactor.ts            # API communication
│   └── strategies.ts         # Platform-specific strategies
├── shared/
│   ├── config_service.ts     # Configuration management
│   ├── constants.ts          # Constants and magic values
│   ├── i18n.ts               # Internationalization
│   ├── log_service.ts        # Logging service
│   └── types.ts              # TypeScript type definitions
└── view/
    ├── hud.ts                # Webview panel management
    └── webview/
        ├── dashboard.css     # Dashboard styles
        └── dashboard.js      # Dashboard logic
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Guidelines

- Follow the ESLint configuration (`.eslintrc.json`)
- Use TypeScript with strict mode
- Add JSDoc comments to public APIs
- Test on Windows, macOS, and Linux if possible

---

## 📝 Changelog

For a complete list of changes and version history, see [CHANGELOG.md](CHANGELOG.md).

---

## ⭐ Support This Project

If you find **Antigravity Cockpit** useful, consider giving it a star on GitHub! Your support helps keep this project alive and motivates further development.

[![GitHub stars](https://img.shields.io/github/stars/jlcodes99/vscode-antigravity-cockpit?style=social)](https://github.com/jlcodes99/vscode-antigravity-cockpit)

- ⭐ **[Star on GitHub](https://github.com/jlcodes99/vscode-antigravity-cockpit)** - Show your support!
- 💬 **[Report Issues / Feedback](https://github.com/jlcodes99/vscode-antigravity-cockpit/issues)** - Help us improve!
- 📖 **[Rate on Marketplace](https://marketplace.visualstudio.com/items?itemName=jlcodes.antigravity-cockpit&ssr=false#review-details)** - Leave a review!

> 如果觉得这个插件好用，给个 ⭐ Star 支持一下吧！您的支持是我持续更新的动力 💪

---

## License

[MIT](LICENSE)
