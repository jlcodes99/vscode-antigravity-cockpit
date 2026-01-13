# Changelog

English · [Chinese](CHANGELOG.zh-CN.md)

All notable changes to the Antigravity Cockpit extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.8.36]

### Fixed
- **Windows Local Auth Import**: Fixed `spawn sqlite3 ENOENT` error on Windows when importing local accounts. Replaced system `sqlite3` command-line tool with pure JavaScript `sql.js` library for cross-platform compatibility.
- **Account Switching**: Fixed issue where manually switching accounts in the Manage Accounts modal would be reverted to the original account during quota refresh.

### Added
- **Switch to Current Login**: Added "Switch to Current Login" button on the authorized account row. Click to quickly sync to the account currently logged in on Antigravity Tools or the local client. If the account exists, it switches directly; if not, an import confirmation dialog appears.

## [1.8.35]

### Changed
- **Model Management**: Unified model management logic for local and authorized sources, ensuring a consistent experience across different quota origins.
- **Model Management**: Local mode now supports automatic sorting (weighted by recommended rank) and default selection of recommended models.
- **UI**: The "Select Recommended" button in the model manager is now always available regardless of the quota source.

## [1.8.34]

### Changed
- **Local Quota**: Optimized local quota fetching to prioritize remote API using local account credentials (from `state.vscdb`), with local process API as fallback. This improves data accuracy while maintaining compatibility.
- **Auto Import**: Local account credentials are now automatically imported to credential storage on first use, enabling seamless switching between local and authorized modes.
- **UI**: Hidden the "Plan" button by default and collapsed the Plan Details section.

### Added
- **Local Account Display**: Local mode now displays the current account email when using remote API.

## [1.8.33]

### Added
- **Local Auth Importer**: Read Antigravity client tokens from `state.vscdb` and support local account import with preview/overwrite flow.
- **Account Sync Settings**: New sync config modal with feature overview, auto sync/auto switch toggles, and manual import for local/Antigravity Tools accounts.

### Changed
- **Auto Sync Flow**: Moved auto sync to backend handling with optional import-only mode; auto switch refreshes quota after switching.
- **UI**: Refined sync config layout, button alignment, and copy for a more compact experience.

### Fixed
- **Authorized Quota**: Avoid stale quota updates after fast account removal/switching by clearing cache and dropping outdated results.
- **Windows Port Detection**: Use PowerShell `Get-NetTCPConnection` to avoid localized `LISTENING` parsing failures.

## [1.8.32]

### Changed
- **Auth UI**: Unified the authorized account bar across dashboard and auto wake-up via a shared component.
- **Auto Wake-up**: Moved the authorized account bar into a standalone card to match the dashboard layout.
- **Build**: Bundle the shared auth UI script for webview reuse.

## [1.8.31]

### Added
- **Antigravity Tools Sync**: Seamlessly import accounts from Antigravity Tools with automatic token refresh; supports both "Import and Switch" and "Import Only" modes.
- **Manager Sync UI**: New dashboard section for Antigravity Tools account synchronization with import mode dropdown selector.
- **Auto Wake-up**: Added `maxOutputTokens` configuration option for wake-up triggers.

### Changed
- **Account Management**: Improved account removal logic; schedule automatically disables when all selected accounts are removed.
- **Auto Wake-up**: Enhanced account candidate resolution; strictly respects explicitly configured account lists without fallback behavior.
- **Auto Wake-up History**: Improved trigger history formatting with grouped per-model results and highlights.
- **OAuth Service**: Optimized token refresh flow with improved error handling for imported accounts.
- **i18n**: Added translations for Manager Sync, import modes, and OAuth notifications across all 14 supported languages.
- **QuickPick**: Reset time display now follows the system locale.
- **Status Bar**: Reset countdown now includes local reset time.

### Fixed
- **Schedule Config**: Schedule state now properly persists when selected accounts change due to account removal.

---

## [1.8.2]

### Added
- **Auto Wake-up**: Time window policy for "Wake on Quota Reset" mode; allows defining active working hours for reset-based triggers and fallback fixed times for non-working hours.
- **Auto Wake-up**: Status card now displays the selected accounts for auto wake-up, with a consolidated display for multiple accounts and full list in tooltip.
- **i18n**: Completed full translations for time window settings and account labels across all 14 supported languages.

## [1.8.1]

### Changed
- **Auto Wake-up**: Stream requests now capture full SSE payloads and record usage/traceId in trigger history; missing completion tokens default to 0, and output is capped at 8 tokens for wake pings.
- **Manual Test**: Model picker supports multi-select (defaults stay the same) and triggers run concurrently per selected model.
- **Networking**: Added a streaming helper with retry/backoff; auto wake-up uses it to fetch stream responses.

## [1.8.0]

### Added
- **Auto Wake-up**: Multi-account selection for scheduled/auto wake-ups and manual tests.
- **Account Management**: New account management modal with reauthorize/remove actions and account status badges.

### Changed
- **Authorized UI**: Consolidated authorized card layout with account dropdown and clickable status area.
- **Trigger History**: History entries now show account badges for easier attribution.

## [1.7.24]

### Fixed
- **Language**: Auto-follow VS Code language now updates the dashboard/quickpick after language switches.
- **Language**: Settings panel now reflects the saved language selection instead of always showing "Auto".

## [1.7.23]

### Added
- **Announcements**: Added image skeleton loaders and an error fallback UI for announcement images.

### Changed
- **Announcements**: Popup announcements now only show once per announcement ID.
- **Telemetry**: The dashboard now refreshes announcement state alongside snapshot updates to surface new announcements promptly.

### Removed
- **Debug**: Removed the development-only "Reset Extension State" command.

## [1.7.22]

### Added
- **Authorized Quota**: Model capability fields (`supportsImages`, `isRecommended`, `tagTitle`, `supportedMimeTypes`) now available in authorized mode, consistent with local mode.

### Improved
- **Webview Management**: Implemented WebviewPanelSerializer to properly restore webview panel after extension reload, preventing orphan panels and ensuring the latest code is always used.

## [1.7.21]

### Fixed
- **Announcements**: Announcement language filtering now respects the manual language setting.

## [1.7.2]

### Added
- **Manual Language Setting**: Added a manual language selector in the Dashboard settings to override the default VS Code language.

## [1.7.1]

### Changed
- **Authorized Quota**: Prefer Cloud Code production endpoint with sandbox fallback, and resolve project ID via loadCodeAssist with onboardUser fallback.
- **Auto Wake-up**: Use the same primary Cloud Code endpoint with fallback.
- **Logging**: Cloud Code request logs now include the full request URL for easier troubleshooting.
- **Reliability**: Authorized quota requests use retry/backoff and reuse cached data on transient failures.
- **Authorization**: Detect invalid refresh tokens explicitly and log clearer token states.
- **Cloud Code Client**: Unified request logic across authorized quota and auto wake-up with shared retry rules.
- **Error Handling**: Treat 403 as non-retryable to avoid noisy loops.

### Fixed
- **Loading State**: Fixed an issue where the loading screen would get stuck indefinitely during initial installation or when switching quota sources.

### Refactor
- **Configuration Persistence**: Migrated `quotaSource` setting to global state to resolve VS Code setting synchronization conflicts and write failures. Old configuration is automatically migrated and cleaned up.

## [1.7.0]

### Added
- **Authorized Quota Source**: Monitor quotas without a local process, sharing credentials with Auto Wake-up. Added source toggle UI and authorization status card.
- **Model Visibility**: Manage which models appear in the dashboard and status bar.
- **Debug Command**: Added "Reset Extension State" command (development mode only) to clear all state data for fresh install simulation.

### Changed
- **Auto Wake-up**: Concurrent triggering with a summarized result log, plus more stable reset detection (rising-edge, cooldown, valid reset time).
- **Refresh**: Manual refresh cooldown reduced to 10 seconds.

### Fixed
- **Auto Wake-up**: Fixed scheduled trigger bug where only the first time point was triggered when multiple times with different minutes (e.g., `07:00`, `09:30`) were configured.
- **Auto Wake-up**: Fixed weekly mode multi-time bug, now supports multiple time points with different minutes.
- **Auto Wake-up**: Fixed status page mode display showing only the first time point, now shows all time points.
- **Authorized Monitoring**: Removed redundant prompt text when not authorized.

### Migration
- **Why**: Group/model personalization (order, pins, custom names, visibility) grew settings.json, created sync noise, and behaved more like per-device UI state.
- **What**: Move these UI preferences from settings to globalState (no cross-device sync), and clean up legacy settings. Removed list view and the `viewMode` setting.

## [1.6.15]

### Added
- **Auto Wake-up**: Wake on quota reset mode and trigger history now records the exact auto mode.
- **Auto Wake-up**: Custom wake word support for triggers and tests.

### Improved
- **Auto Wake-up**: Wake-up configuration UI reorganized by wake-up method with per-mode settings and previews.
- **Notifications**: In quota grouping mode, threshold notifications fire once per group instead of per model.
- **Status Bar**: Opening the webview defaults to the quota monitor tab.

## [1.6.14]

### Added
- **Announcement**: Enhanced announcement system with image support (QR codes, etc.) and per-language content targeting.
- **Announcement**: Added "Click to Enlarge" preview for announcement images.

## [1.6.13]

### Improved
- **Auto Wake-up**: Custom time input plus unified daily/weekly preset times
- **Auto Wake-up**: More accurate cron parsing and safer long-delay scheduling

## [1.6.12]

### Improved
- **Auto Wake-up**: Added "Manual/Auto" labels in trigger history for better clarity

## [1.6.11]

### Improved
- **Announcement**: UX improvements for announcement list and popup

## [1.6.1]

### Fixed
- **i18n**: Optimized translation files and fixed minor text issues

## [1.6.0]

### Added
- **Auto Wake-up**: New feature to schedule automated requests to AI models
  - Set up timed wake-up calls to trigger quota reset cycles in advance
  - Supports daily, weekly, interval-based, and advanced Crontab scheduling
  - Multi-model selection: choose which models to trigger
  - Trigger history with request/response details (persisted for 7 days, up to 40 records)
  - Next trigger time displayed in the main quota tooltip
  - Secure credential storage using VS Code's built-in Secret Storage API
  - Google OAuth authentication for API access
- **Announcement System**: New remote notification system
  - Dynamic delivery of new features, important notices, and update notes
  - Supports popup alerts, mark-as-read, and notification history

## [1.5.48]

### Fixed
- **i18n**: Fixed hardcoded text not using translation files

## [1.5.47]

### Fixed
- **List View Consistency**: Updated list view to use the same "Manage Groups" logic as the card view, ensuring consistent group management across all views.

## [1.5.46]

### Added
- **Custom Grouping**: New "Manage Groups" modal for manual group management
  - Create, rename, and delete custom groups
  - Add/remove models to groups with multi-select support
  - Compatible models sorted first; incompatible models dynamically disabled
  - "Auto Group" button to pre-fill groups based on quota (preserves existing group names via majority vote)
  - Quota validation: only models with same quota and reset time can be grouped
  - Models auto-removed from group when quota changes cause inconsistency (minority models removed, majority retained)

### Improved
- **Toast Notifications**: Now displayed above all modals (z-index: 9999)
- **Privacy**: Telemetry and error reporting are now **disabled by default**. Users can manually enable them in settings (`agCockpit.telemetryEnabled`) if they wish to help improve the extension.

## [1.5.45]

### Refactor
- **Error Handling**: Introduced `AntigravityError` class to uniformly manage and filter expected errors (timeouts, server messages, startup checks) from Sentry reporting

## [1.5.44]

### Fixed
- **Startup Protection**: Prevent API requests before system is fully engaged (port 0), avoiding erroneous "Connection Refused (443)" errors

## [1.5.43]

### Fixed
- **Proxy Bypass**: Forced bypass of HTTP proxy for localhost connections to resolve timeouts when users have global proxy settings enabled

## [1.5.42]

### Improved
- **Error Reporting**: Server-side errors (e.g., "not logged in") are no longer reported to Sentry

## [1.5.41]

### Improved
- **Network Timeout**: Increased HTTP request timeout from 5s to 10s for better compatibility with WSL2 and slow network environments

## [1.5.40]

### Improved
- **Auto Group Split**: Groups are now automatically split when model quotas become inconsistent during refresh

## [1.5.39]

### Improved
- **Error Reporting**: Only report errors that occur during initial startup; subsequent sync failures after successful data fetch are silently ignored
- **Server Error Display**: Backend error messages are now transparently shown to users with "Antigravity Error:" prefix instead of generic "Invalid server response"

## [1.5.38]

### Improved
- **Error Reporting**: Added anonymous user/session identifiers and editor metadata to better separate user environments
- **Diagnostics Context**: Included runtime limits and extension configuration snapshots in error events
- **Tagging**: Added editor, URI scheme, and UI kind tags for quick filtering
- **Port Scan Insight**: Attached scan method and port verification details to error context

## [1.5.37]

### Added
- **Error Reporting**: Lightweight anonymous error reporting to help improve the extension
  - Automatically captures and reports errors for faster bug fixes
  - Respects VS Code's global telemetry settings
  - Can be disabled via `agCockpit.telemetryEnabled` setting
  - Collects: error stack trace, OS type & version, VS Code version, extension version

## [1.5.36]

### Improved
- **Windows Process Detection**: Refactored detection logic to exclusively use PowerShell with robust UTF-8 encoding enforcement. This resolves garbled error messages on non-English systems and eliminates reliance on the deprecated `wmic` tool.
- **Connection Stability**: Increased PowerShell connection timeout from 8s to 15s to better accommodate environments with long cold start times.

## [1.5.35]

- Fix: Resolved 'Unexpected end of JSON input' startup error with auto-recovery logic
- Improved: Enhanced diagnostic logging for API response errors

## [1.5.34]

### Improved
- **Remaining Time Display**: Adaptive time format for better readability
  - Less than 60 minutes: `Xm` (e.g., `45m`)
  - Less than 24 hours: `Xh Ym` (e.g., `4h 57m`)
  - 24 hours or more: `Xd Yh Zm` (e.g., `1d 2h 30m`)

## [1.5.33]

### Fixed
- **Data Masking**: Added missing `agCockpit.dataMasked` configuration declaration in `package.json`, fixing the issue where "Hide Data" button had no effect.

## [1.5.32]

### Fixed
- **Translation Key**: Fixed incorrect translation key `status.error` → `statusBar.error` in status bar controller.
- **Data Masking Persistence**: "Hide Data" state in Plan Details now persists across Dashboard reopens and restarts.
- **Variable Declaration Order**: Moved `isProfileHidden` and `isDataMasked` declarations to top of dashboard.js for better code organization.

### Improved
- **UX**: Changed reset countdown text from "Restored" to "Restoring Soon" for more accurate representation (quota restore has latency).
- **i18n**: Updated `dashboard.online` translations in all 14 languages.

## [1.5.31]

### Fixed
- **Memory Leak**: Fixed event listener leak in Logger service - now properly disposes configuration change listener.
- **Duplicate Notifications**: Removed duplicate quota notification logic in ReactorCore - notifications are now handled exclusively by TelemetryController.

### Improved
- **Code Cleanup**: Removed unused variables and imports across multiple files.

## [1.5.30]

### Added
- **Unit Testing**: Integrated Jest framework and added tests for process detection logic.
- **Bundling**: Switched build pipeline to `esbuild` for bundling and minification.

### Improved
- **Build**: Reduced VSIX package size from 216 KB to 162 KB.
- **Clean up**: Removed legacy files from build output.

## [1.5.23]

### Improved
- **Detection**: Refined Antigravity process detection by requiring server port + CSRF token and removing path-based matching to avoid false positives.
- **Optimization**: Reduced VSIX package size by ~67% via `.vscodeignore` (excluded `src`, source maps, and demo assets).
- **Engineering**: Resolved all lint issues and updated TS config to support modern ESM imports.

### Fixed
- **Status Bar**: Corrected status bar tooltip to display user tier name instead of internal ID.

## [1.5.22]

### Fixed
- **Dashboard Update**: Fixed an issue where the dashboard panel would not update with fresh data if it was in the background during an auto-refresh.
- **Quota Precision**: Fixed a discrepancy in quota percentage display between the dashboard (List View) and Status Bar. Both now consistently round down (floor) to the nearest integer.

## [1.5.21]

### Improved
- **Docs**: Rewrote README with feature list overview

---

## [1.5.20]

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

## [1.5.19]

### Improved
- **QuickPick Mode**: Partial refresh when toggling pin status - only update the clicked item instead of rebuilding the entire list
- **QuickPick Mode**: Removed redundant status icons (check/warning/error), keeping only the pin icon for cleaner UI

---

## [1.5.18]

### Improved
- **Code Architecture**: Refactored `extension.ts` into modular controllers for better maintainability and performance.
- **UI Alignment**: Fixed progress bar alignment issues on Windows by switching to cross-platform compatible block characters.

## [1.5.17]

### Added
- **List View Mode**: New table-style view for quota display
  - Toggle via Settings → View Mode (Card/List)

---

## [1.5.16]

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

## [1.5.15]

### Improved
- **Model Capabilities**: Added rich tooltips for model capabilities, triggered by hovering over the model name.
- **Auto-Grouping**: Optimized logic with a new fallback strategy.

---

## [1.5.14]

### Improved
- **Grouping Mode Guidance**: Added explanatory text to the top of the grouping mode view to guide users on auto-grouping and mode switching.

## [1.5.13]

### Added
- **First-Run Auto-Grouping**: Automatically calculate and save group mappings on first startup when grouping is enabled but no mappings exist

---

## [1.5.12]

### Fixed
- **Status Colors**: Reverted to vibrant status colors (using terminal/chart colors instead of dull icon colors) for better visibility

---

## [1.5.11]

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

## [1.5.1]

### Added
- **Reset Name Button**: Add "Reset" button in rename modal to quickly restore original name

### Fixed
- **Status Bar Sync**: Custom model names now correctly display in the status bar (non-grouping mode)

### Improved
- **Theme Compatibility**: Use VS Code theme variables for colors (tooltip, semantic colors, badges)

---

## [1.5.0]

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

## [1.4.24]

### Changed
- QuickPick mode: Use emoji icons for better visibility across all themes

---

## [1.4.23]

### Added
- QuickPick mode: Add "Switch to Webview Mode" button for easy mode switching

---

## [1.4.22]

### Added
- QuickPick compatibility mode: Use VSCode native QuickPick API instead of Webview
- Better compatibility for environments where Webview is not supported
- Configure via `agCockpit.displayMode: "quickpick"`
- Features: View all model quotas, toggle status bar pinning, refresh data
- Auto-detect Webview failure and prompt user to switch to QuickPick mode

---

## [1.4.21]

### Changed
- Docs: split English/Chinese READMEs and CHANGELOGs with language switch links
- Docs: use Open VSX badge/link as the primary distribution channel

---

## [1.4.20]

### Fixed
- Fix startup crash when the service is not ready (500) causing `Cannot read properties of undefined`
- Validate server responses and surface clearer error messages

### Added
- Startup auto-retry: retry up to 3 times when initial sync fails

---

## [1.4.19]

### Security
- Mask sensitive data (`csrf_token`) in diagnostic logs to prevent leakage

---

## [1.4.18]

### Added
- Add a dedicated `CHANGELOG.md` to track version history

### Changed
- README: link Changelog section to the dedicated changelog file
- Remove redundant `activationEvents` config (auto-generated by VS Code)

---

## [1.4.17]

### Added
- Print extension version in startup logs for easier debugging

---

## [1.4.16]

### Fixed
- Improve process detection to precisely match Antigravity processes
- Avoid false positives from other editors (e.g. Windsurf)
- Require `--app_data_dir antigravity` or paths containing `antigravity`

---

## [1.4.15]

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

## [1.4.14]

### Fixed
- Fix process detection in multi-process scenarios
- Improve process validation logic

---

## [1.4.13]

### Changed
- Rename groups via a modal input dialog
- Remove "Last Updated" display from the dashboard

---

## [1.4.12]

### Fixed
- Fix PowerShell cold-start timeout issues
- Increase process command execution timeout to 8 seconds

---

## [1.4.11]

### Changed
- Version number cleanup

---

## [1.4.1]

### Added
- Toggle for quota threshold notifications

### Fixed
- Fix notification toggle state not being passed to the frontend
- Fix threshold color logic errors when clicking the status bar / refreshing cache

---

## [1.4.0]

### Added
- Configurable warning/critical thresholds
- Keyboard shortcuts (open logs, open dashboard, etc.)
- Feedback entry (GitHub Issues)
- Threshold notification feature

### Improved
- Improve quota evaluation logic
- Unify color display standards

---

## [1.3.14]

### Added
- Add fallback keyword search via `csrf_token` to find processes

### Fixed
- Fix PowerShell quote escaping issues

---

## [1.3.12]

### Fixed
- Fix dashboard status logic
- Improve i18n support
- Use full model names in tooltips

---

## [1.3.1]

### Added
- Color status indicator in status bar (🟢🟡🔴)
- Unified three-state quota logic

### Improved
- Precision fixes
- Align tooltip model order with the dashboard

---

## [1.3.0]

### Added
- Tooltip alignment improvements
- Unified threshold configuration
- Auto-retry mechanism

---

## [1.2.16]

### Added
- Auto-group on first switch to grouping mode

---

## [1.2.15]

### Added
- Manual auto-grouping action
- Persist group mappings

---

## [1.2.13]

### Fixed
- Ensure auto-pin runs before UI refresh

---

## [1.2.12]

### Fixed
- Use stable `groupId` based on model IDs

---

## [1.2.11]

### Fixed
- Multiple improvements and bug fixes

---

## [1.2.1]

### Fixed
- Auto-pin all groups when grouping is first enabled

---

## [1.2.0]

### Added
- Quota grouping feature
- Custom group names
- Drag-and-drop sorting for groups
- Show groups in the status bar

---

## [1.1.153]

### Added
- Toggle trend chart visibility

---

## [1.1.152]

### Added
- Quota history charts (keep 7 days of data)

---

## [1.1.151]

### Improved
- Simplify profile controls
- Use a text button for data masking
- Move visibility toggle to the header area

---

## [1.1.150]

### Added
- Profile visibility toggle
- Sensitive data masking

---

## [1.1.149]

### Added
- Privacy mode
- Profile visibility toggle

---

## [1.1.148]

### Fixed
- Remove Prompt Credits setting
- Update status bar when configuration changes

---

## [1.1.147]

### Fixed
- Automatically rescan on connection failure

---

## [1.1.146]

### Fixed
- Fix status bar error state not being cleared

---

## [1.1.144]

### Changed
- Rename "User ID" to "Internal Tier ID"

---

## [1.1.143]

### Added
- Localize detailed profile fields

---

## [1.1.142]

### Improved
- Move context window logic into a fixed area

---

## [1.1.14]

### Added
- Full profile details
- State persistence

---

## [1.1.13]

### Improved
- Improve UI interactions
- Fix pin toggle behavior

---

## [1.1.12]

### Improved
- Enhance debug logs
- Improve refresh behavior

---

## [1.1.11]

### Fixed
- Floor the percentage to avoid misleading 100%

---

## [1.0.0]

### Added
- Initial release 🎉
- Immersive dashboard
- Precision timing
- Interactive controls (drag sorting, pin models)
- Smart status bar
- Smart notifications
- English/Chinese support
- Cross-platform support (Windows / macOS / Linux)
