# Changelog

English · [Chinese](CHANGELOG.zh-CN.md)

All notable changes to the Antigravity Cockpit extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.5.21] - 2025-12-22

### Improved
- **Docs**: Rewrote README with feature list overview

---

## [1.5.20] - 2025-12-21

### Added
- **QuickPick Mode**: Full grouping mode support - now mirrors Webview's grouping functionality
- **QuickPick Mode**: Title bar action buttons (Refresh, Toggle Grouping, Logs, Settings, Webview)
- **QuickPick Mode**: Auto-group button in title bar (only visible in grouping mode)
- **QuickPick Mode**: Rename and reset buttons for each model/group item
- **QuickPick Mode**: Refresh cooldown mechanism to prevent rapid consecutive refreshes

### Improved
- **QuickPick Mode**: Actions moved from list items to title bar buttons for cleaner UI
- **QuickPick Mode**: Progress bar and reset time moved to detail line for better alignment
- **Translations**: Added QuickPick-specific translations for all 13 supported languages

---

## [1.5.19] - 2025-12-21

### Improved
- **QuickPick Mode**: Partial refresh when toggling pin status - only update the clicked item instead of rebuilding the entire list
- **QuickPick Mode**: Removed redundant status icons (check/warning/error), keeping only the pin icon for cleaner UI

---

## [1.5.18] - 2025-12-19

### Improved
- **Code Architecture**: Refactored `extension.ts` into modular controllers for better maintainability and performance.
- **UI Alignment**: Fixed progress bar alignment issues on Windows by switching to cross-platform compatible block characters.

## [1.5.17] - 2025-12-19

### Added
- **List View Mode**: New table-style view for quota display
  - Toggle via Settings → View Mode (Card/List)

---

## [1.5.16] - 2025-12-19

### Added
- **Multi-Language Support**: Extended i18n support from 2 to 14 languages
  - 🇺🇸 English (en)
  - 🇨🇳 简体中文 (zh-cn)
  - 🇯🇵 日本語 (ja) - NEW
  - 🇪🇸 Español (es) - NEW
  - 🇩🇪 Deutsch (de) - NEW
  - 🇫🇷 Français (fr) - NEW
  - 🇧🇷 Português do Brasil (pt-br) - NEW
  - 🇷🇺 Русский (ru) - NEW
  - 🇰🇷 한국어 (ko) - NEW
  - 🇮🇹 Italiano (it) - NEW
  - 🇹🇼 繁體中文 (zh-tw) - NEW
  - 🇹🇷 Türkçe (tr) - NEW
  - 🇵🇱 Polski (pl) - NEW
  - 🇨🇿 Čeština (cs) - NEW

### Improved
- **Modular Translations**: Refactored i18n to use separate translation files for better maintainability
- **Language Detection**: Enhanced locale detection with fallback mapping for language variants

---

## [1.5.15] - 2025-12-18

### Improved
- **Model Capabilities**: Added rich tooltips for model capabilities, triggered by hovering over the model name.
- **Auto-Grouping**: Optimized logic with a new fallback strategy.

---

## [1.5.14] - 2025-12-18

### Improved
- **Grouping Mode Guidance**: Added explanatory text to the top of the grouping mode view to guide users on auto-grouping and mode switching.

## [1.5.13] - 2025-12-18

### Added
- **First-Run Auto-Grouping**: Automatically calculate and save group mappings on first startup when grouping is enabled but no mappings exist

---

## [1.5.12] - 2025-12-17

### Fixed
- **Status Colors**: Reverted to vibrant status colors (using terminal/chart colors instead of dull icon colors) for better visibility

---

## [1.5.11] - 2025-12-16

### Added
- **Name + Percent Mode**: New status bar format showing `Sonnet: 95%` (without status dot)

### Changed
- **Status Bar Selector**: Changed from button grid to dropdown for cleaner UI
- **Settings Title**: Simplified from "Alert Settings" to "Settings"
- **Auto-Save Settings**: All settings now auto-save immediately (no Save button needed)
- **Threshold Auto-Clamp**: Out-of-range values automatically adjusted to valid range

### Fixed
- **Settings Modal Persistence**: Modal no longer closes when data auto-refreshes

---

## [1.5.1] - 2025-12-16

### Added
- **Reset Name Button**: Add "Reset" button in rename modal to quickly restore original name

### Fixed
- **Status Bar Sync**: Custom model names now correctly display in the status bar (non-grouping mode)

### Improved
- **Theme Compatibility**: Use VS Code theme variables for colors (tooltip, semantic colors, badges)

---

## [1.5.0] - 2025-12-16

### Added
- **Model Rename**: Rename individual models in non-grouping mode (click ✏️ icon on model cards)
- **Status Bar Style Selector**: 5 display modes available in Settings modal
  - Icon only (`🚀`)
  - Status dot only (`🟢` | `🟡` | `🔴`)
  - Percent only (`95%`)
  - Dot + Percent (`🟢 95%`)
  - Full display (`🟢 Sonnet: 95%`) - default

### Changed
- Settings modal now includes status bar style picker with live preview
- Custom model names persist across sessions

---

## [1.4.24] - 2025-12-15

### Changed
- QuickPick mode: Use emoji icons for better visibility across all themes

---

## [1.4.23] - 2025-12-15

### Added
- QuickPick mode: Add "Switch to Webview Mode" button for easy mode switching

---

## [1.4.22] - 2025-12-15

### Added
- QuickPick compatibility mode: Use VSCode native QuickPick API instead of Webview
- Better compatibility for environments where Webview is not supported
- Configure via `agCockpit.displayMode: "quickpick"`
- Features: View all model quotas, toggle status bar pinning, refresh data
- Auto-detect Webview failure and prompt user to switch to QuickPick mode

---

## [1.4.21] - 2025-12-15

### Changed
- Docs: split English/Chinese READMEs and CHANGELOGs with language switch links
- Docs: use Open VSX badge/link as the primary distribution channel

---

## [1.4.20] - 2025-12-15

### Fixed
- Fix startup crash when the service is not ready (500) causing `Cannot read properties of undefined`
- Validate server responses and surface clearer error messages

### Added
- Startup auto-retry: retry up to 3 times when initial sync fails

---

## [1.4.19] - 2025-12-13

### Security
- Mask sensitive data (`csrf_token`) in diagnostic logs to prevent leakage

---

## [1.4.18] - 2025-12-13

### Added
- Add a dedicated `CHANGELOG.md` to track version history

### Changed
- README: link Changelog section to the dedicated changelog file
- Remove redundant `activationEvents` config (auto-generated by VS Code)

---

## [1.4.17] - 2025-12-13

### Added
- Print extension version in startup logs for easier debugging

---

## [1.4.16] - 2025-12-13

### Fixed
- Improve process detection to precisely match Antigravity processes
- Avoid false positives from other editors (e.g. Windsurf)
- Require `--app_data_dir antigravity` or paths containing `antigravity`

---

## [1.4.15] - 2025-12-13

### Fixed
- Fix all ESLint errors (23 → 0)
- Replace `require()` with dynamic ES module `import()`
- Add block scoping braces for `case` clauses
- Fix TypeScript `any` warnings

### Improved
- Improve Windows process detection resilience
- Add automatic PowerShell/WMIC fallback switching
- Add switching limits to prevent infinite loops
- Increase PowerShell cold-start wait time from 1s to 2s
- Detect PowerShell execution policy and WMI service issues
- Improve diagnostics with more user-friendly troubleshooting tips

---

## [1.4.14] - 2025-12-12

### Fixed
- Fix process detection in multi-process scenarios
- Improve process validation logic

---

## [1.4.13] - 2025-12-12

### Changed
- Rename groups via a modal input dialog
- Remove "Last Updated" display from the dashboard

---

## [1.4.12] - 2025-12-12

### Fixed
- Fix PowerShell cold-start timeout issues
- Increase process command execution timeout to 8 seconds

---

## [1.4.11] - 2025-12-12

### Changed
- Version number cleanup

---

## [1.4.1] - 2025-12-11

### Added
- Toggle for quota threshold notifications

### Fixed
- Fix notification toggle state not being passed to the frontend
- Fix threshold color logic errors when clicking the status bar / refreshing cache

---

## [1.4.0] - 2025-12-11

### Added
- Configurable warning/critical thresholds
- Keyboard shortcuts (open logs, open dashboard, etc.)
- Feedback entry (GitHub Issues)
- Threshold notification feature

### Improved
- Improve quota evaluation logic
- Unify color display standards

---

## [1.3.14] - 2025-12-10

### Added
- Add fallback keyword search via `csrf_token` to find processes

### Fixed
- Fix PowerShell quote escaping issues

---

## [1.3.12] - 2025-12-08

### Fixed
- Fix dashboard status logic
- Improve i18n support
- Use full model names in tooltips

---

## [1.3.1] - 2025-12-07

### Added
- Color status indicator in status bar (🟢🟡🔴)
- Unified three-state quota logic

### Improved
- Precision fixes
- Align tooltip model order with the dashboard

---

## [1.3.0] - 2025-12-07

### Added
- Tooltip alignment improvements
- Unified threshold configuration
- Auto-retry mechanism

---

## [1.2.16] - 2025-12-06

### Added
- Auto-group on first switch to grouping mode

---

## [1.2.15] - 2025-12-06

### Added
- Manual auto-grouping action
- Persist group mappings

---

## [1.2.13] - 2025-12-05

### Fixed
- Ensure auto-pin runs before UI refresh

---

## [1.2.12] - 2025-12-05

### Fixed
- Use stable `groupId` based on model IDs

---

## [1.2.11] - 2025-12-05

### Fixed
- Multiple improvements and bug fixes

---

## [1.2.1] - 2025-12-04

### Fixed
- Auto-pin all groups when grouping is first enabled

---

## [1.2.0] - 2025-12-04

### Added
- Quota grouping feature
- Custom group names
- Drag-and-drop sorting for groups
- Show groups in the status bar

---

## [1.1.153] - 2025-12-03

### Added
- Toggle trend chart visibility

---

## [1.1.152] - 2025-12-03

### Added
- Quota history charts (keep 7 days of data)

---

## [1.1.151] - 2025-12-02

### Improved
- Simplify profile controls
- Use a text button for data masking
- Move visibility toggle to the header area

---

## [1.1.150] - 2025-12-02

### Added
- Profile visibility toggle
- Sensitive data masking

---

## [1.1.149] - 2025-12-02

### Added
- Privacy mode
- Profile visibility toggle

---

## [1.1.148] - 2025-12-01

### Fixed
- Remove Prompt Credits setting
- Update status bar when configuration changes

---

## [1.1.147] - 2025-12-01

### Fixed
- Automatically rescan on connection failure

---

## [1.1.146] - 2025-11-30

### Fixed
- Fix status bar error state not being cleared

---

## [1.1.144] - 2025-11-30

### Changed
- Rename "User ID" to "Internal Tier ID"

---

## [1.1.143] - 2025-11-29

### Added
- Localize detailed profile fields

---

## [1.1.142] - 2025-11-29

### Improved
- Move context window logic into a fixed area

---

## [1.1.14] - 2025-11-28

### Added
- Full profile details
- State persistence

---

## [1.1.13] - 2025-11-27

### Improved
- Improve UI interactions
- Fix pin toggle behavior

---

## [1.1.12] - 2025-11-27

### Improved
- Enhance debug logs
- Improve refresh behavior

---

## [1.1.11] - 2025-11-26

### Fixed
- Floor the percentage to avoid misleading 100%

---

## [1.0.0] - 2025-11-25

### Added
- Initial release 🎉
- Immersive dashboard
- Precision timing
- Interactive controls (drag sorting, pin models)
- Smart status bar
- Smart notifications
- English/Chinese support
- Cross-platform support (Windows / macOS / Linux)

