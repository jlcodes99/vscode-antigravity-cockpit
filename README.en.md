# Antigravity Cockpit

English · [简体中文](README.md)

[![Version](https://img.shields.io/open-vsx/v/jlcodes/antigravity-cockpit)](https://open-vsx.org/extension/jlcodes/antigravity-cockpit)
[![Downloads](https://img.shields.io/open-vsx/dt/jlcodes/antigravity-cockpit?color=success)](https://open-vsx.org/extension/jlcodes/antigravity-cockpit)
[![GitHub stars](https://img.shields.io/github/stars/jlcodes99/vscode-antigravity-cockpit?style=flat&color=gold)](https://github.com/jlcodes99/vscode-antigravity-cockpit)
[![GitHub issues](https://img.shields.io/github/issues/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit/issues)
[![License](https://img.shields.io/github/license/jlcodes99/vscode-antigravity-cockpit)](https://github.com/jlcodes99/vscode-antigravity-cockpit)

VS Code extension for monitoring Google Antigravity AI model quotas.

**Features**: Webview Dashboard · QuickPick Mode · Official Model Quota Groups · Weekly / Five-Hour Quota Windows · Card View · Status Bar Monitor · Threshold Notifications · Privacy Mode

**Languages**: Follows VS Code language setting, supports 16 languages

🇺🇸 English · 🇨🇳 简体中文 · 繁體中文 · 🇯🇵 日本語 · 🇩🇪 Deutsch · 🇪🇸 Español · 🇫🇷 Français · 🇮🇹 Italiano · 🇰🇷 한국어 · 🇧🇷 Português · 🇷🇺 Русский · 🇹🇷 Türkçe · 🇵🇱 Polski · 🇨🇿 Čeština · 🇸🇦 العربية · 🇻🇳 Tiếng Việt

---

## Features

### Display Modes

Two display modes available, configurable via `agCockpit.displayMode`:

#### Webview Dashboard

![Dashboard Overview](assets/dashboard_card_grouped.png)

- **Card View**: Card layout for official Model Quota groups
- **Official Quota Groups**: Renders quota groups dynamically from the Antigravity official response when available
- **Multi-Window Display**: Shows weekly, five-hour, or other quota windows in the same card when returned by the official API
- **Model Details**: Expand groups to view included models and their remaining quota

#### QuickPick Mode

![QuickPick Mode](assets/quickpick_mode.png)

Uses VS Code native QuickPick API, suitable for:
- Environments where Webview cannot load
- Users who prefer keyboard navigation
- Quick quota checks

Features:
- Shows quotas by official quota group
- Title bar buttons: Refresh, Logs, Settings, Switch to Webview
- Displays official quota windows and included model details
- Fixed group cards keep previous interactions: drag ordering, rename, and pin to status bar

---

### Status Bar

Displays quota status of monitored models. 6 formats available:

| Format | Example |
|--------|---------|
| Icon only | `🚀` |
| Dot only | `🟢` / `🟡` / `🔴` |
| Percent only | `95%` |
| Dot + Percent | `🟢 95%` |
| Name + Percent | `Sonnet: 95%` |
| Full display | `🟢 Sonnet: 95%` |

- **Official Group First**: Uses fixed official groups in the status bar; pin groups from the card switch, otherwise the group with the lowest remaining quota is shown
- **Compatible Monitor**: Falls back to the model with lowest remaining quota when no quota group is available

---

### Quota Display

Each model / official quota group shows:
- **Remaining quota percentage**
- **Countdown**: e.g., `4h 40m`
- **Reset time**: e.g., `15:16`
- **Progress bar**: Visual representation of remaining quota
- **Quota windows**: When the official API returns `Weekly Limit` / `Five Hour Limit`, each window is shown separately

---

### Quota Source (Local / Authorized)

Two quota sources are available, and you can switch from the top-right of the panel at any time:

- **Local Monitoring (default)**: Reads from the local Antigravity client process. On Windows, PowerShell looks up the process and listening ports.
- **Authorized Monitoring**: Fetches quota via authorized remote APIs, independent of the local process; ideal for API relays or headless usage
- **Multi-account Authorization**: Authorized monitoring supports multiple accounts with account switching and status badges
- **Switching Tips**: Shows loading/timeout hints during switches; you can switch back to local if the network is unstable

---

### Model Capabilities Tooltip

![Model Capabilities Tooltip](assets/model_capabilities_tooltip.png)

Hover over model name to view:
- Supported input types (text, image, video, etc.)
- Context window size
- Other capability tags

---

### Official Model Quota

- **Official First**: Quota group names, included models, and quota windows prefer the structure returned by the Antigravity official API
- **Dynamic Updates**: If the official client adds or renames quota groups later, the extension will render the returned data as directly as possible
- **Compatible Fallback**: When only per-model `quotaInfo` is returned, the extension creates provider-based compatibility groups and shows the real available reset window
- **Consistent Views**: Dashboard, QuickPick, Status Bar, Account Tree, and Accounts Overview use the same official quota group data

---

### Settings Panel

![Settings Modal](assets/settings_modal.png)

Open via gear icon in dashboard header. Configure:
- Status bar display format
- Warning threshold (yellow)
- Critical threshold (red)
- View mode (card / list)
- Notification toggle

---

### Profile Panel

Displays:
- Subscription tier
- User ID
- Collapsible, sensitive data can be masked

---

### Notifications

Sends notifications when model quota falls below warning threshold or is exhausted. Can be disabled in settings.

---

## Usage

1. **Open**:
   - Click status bar icon
   - Or `Ctrl/Cmd+Shift+Q`
   - Or run `Antigravity Cockpit: Open Dashboard` from command palette

2. **Refresh**: Click refresh button or `Ctrl/Cmd+Shift+R` (when dashboard is active)

3. **Troubleshooting**:
   - Click **Retry Connection** when showing "Systems Offline"
   - Click **Open Logs** to view debug logs (authorized requests show full URLs to identify domains)

---

---

### Auto Wake-up

**NEW** 🔥 Schedule automated requests to wake up AI models and trigger quota reset cycles.

- **Flexible Scheduling**: Supports daily, weekly, interval, and advanced Crontab modes
- **Multi-Model Support**: Wake up multiple models simultaneously
- **Multi-Account Authorization**: Authorize multiple accounts, switch active account, and view account status
- **Account Management**: Manage accounts with reauthorize/remove actions
- **Secure**: Credentials encrypted in VS Code Secret Storage, running locally
- **History**: View detailed trigger logs and AI responses
- **Use Case**: Wake up before work to run through the reset cooldown during idle time

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `agCockpit.displayMode` | `webview` | Display mode: `webview` / `quickpick` |
| `agCockpit.refreshInterval` | `120` | Refresh interval (seconds, 10-3600) |
| `agCockpit.statusBarFormat` | `standard` | Status bar format |
| `agCockpit.showPromptCredits` | `true` | Show Credits in the status bar and its tooltip |
| `agCockpit.warningThreshold` | `30` | Warning threshold (%) |
| `agCockpit.criticalThreshold` | `10` | Critical threshold (%) |
| `agCockpit.notificationEnabled` | `true` | Enable notifications |
| `agCockpit.pinnedModels` | `[]` | Models pinned to status bar |

---

## Installation

### Open VSX Marketplace
1. `Cmd/Ctrl+Shift+X` to open Extensions panel
2. Search `Antigravity Cockpit`
3. Click Install

### VSIX File
```bash
code --install-extension antigravity-cockpit-x.y.z.vsix
```

---

## Build from Source

```bash
# Clone repository
git clone https://github.com/jlcodes99/vscode-antigravity-cockpit.git
cd vscode-antigravity-cockpit

# Install dependencies
npm install

# Compile
npm run compile

# Package
npm run package
```

Requirements: Node.js v18+, npm v9+

---

## Changelog

- [CHANGELOG.md](CHANGELOG.md) (English)
- [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese)

---

## Acknowledgements

- The initial process detection logic of this project was referenced from [Antigravity Quota](https://github.com/Henrik-3/AntigravityQuota).
- [Antigravity Quota](https://github.com/Henrik-3/AntigravityQuota)'s process detection logic originated from [AntigravityQuotaWatcher](https://github.com/wusimpl/AntigravityQuotaWatcher).

Thanks to all the above project authors for their open-source contributions! If these projects are helpful to you, please give them a ⭐ Star too!

---

## Support

- ⭐ [GitHub Star](https://github.com/jlcodes99/vscode-antigravity-cockpit)
- 💬 [Report Issues](https://github.com/jlcodes99/vscode-antigravity-cockpit/issues)

---

## ☕ Buy Me a Coffee

If you find this extension helpful, consider buying me a coffee! Your support keeps me motivated to continue improving ❤️

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-orange?style=for-the-badge&logo=buy-me-a-coffee)](docs/DONATE.en.md)

---

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=jlcodes99/vscode-antigravity-cockpit&type=Date)](https://star-history.dera.page/#jlcodes99/vscode-antigravity-cockpit&Date)

---

## License

[MIT](LICENSE)

---

## Disclaimer

This project is intended for personal learning and research purposes only. By using this project, you agree to:

- Not use this project for any commercial purposes
- Assume all risks and responsibilities associated with using this project
- Comply with relevant service terms and applicable laws

The author is not responsible for any direct or indirect damages arising from the use of this project.
