/**
 * Antigravity Cockpit - 国际化支持
 * 简单的 i18n 实现，支持英文、简体中文、繁體中文（台灣）
 */

import * as vscode from 'vscode';

/** 支持的语言 */
export type SupportedLocale = 'en' | 'zh-cn' | 'zh-tw';

/** 翻译键值对 */
interface TranslationMap {
    [key: string]: string;
}

/** 翻译资源 */
const translations: Record<SupportedLocale, TranslationMap> = {
    'en': {
        // 状态栏
        'statusBar.init': 'Quota Monitor: Init...',
        'statusBar.connecting': 'Quota Monitor: Connecting...',
        'statusBar.ready': 'Quota Monitor: Ready',
        'statusBar.offline': 'Quota Monitor: Offline',
        'statusBar.error': 'Quota Monitor: Error',
        'statusBar.failure': 'Quota Monitor Failure',
        'statusBar.lowest': 'Lowest',
        'statusBar.credits': 'Credits',
        'statusBar.tooltip': 'Click to open Quota Monitor',

        // Dashboard
        'dashboard.title': 'Antigravity Quota Monitor',
        'dashboard.connecting': 'Connecting...',
        'dashboard.offline': 'Systems Offline',
        'dashboard.offlineDesc': 'Could not detect Antigravity process. Please ensure Antigravity is running.',
        'dashboard.refresh': 'REFRESH',
        'dashboard.refreshing': 'Refreshing...',
        'dashboard.showCredits': 'Show Prompt Credits',
        'dashboard.promptCredits': 'Prompt Credits',
        'dashboard.available': 'Available',
        'dashboard.monthly': 'Monthly',
        'dashboard.resetIn': 'Reset In',
        'dashboard.resetTime': 'Reset Time',
        'dashboard.status': 'Status',
        'dashboard.exhausted': 'Exhausted',
        'dashboard.active': 'Healthy',
        'dashboard.warning': 'Warning',
        'dashboard.danger': 'Danger',
        'dashboard.online': 'Restored',
        'dashboard.dragHint': 'Drag to reorder',
        'dashboard.pinHint': 'Pin to Status Bar',
        'dashboard.resetOrder': 'Reset Order',
        'profile.planDetails': 'Plan',
        'profile.togglePlan': 'Toggle Plan Details',
        'dashboard.offlineHint': 'Use the status bar button to retry connection.',

        // 通知
        'notify.refreshing': 'Refreshing quota data...',
        'notify.refreshed': 'Quota data refreshed',
        'notify.exhausted': '{model} quota exhausted! Resets in {time}',
        'notify.warning': '{model} quota low ({percent}%)',
        'notify.offline': 'Quota Monitor: Systems offline. Could not detect Antigravity process.',
        'notify.bootFailed': 'Quota Monitor: Boot failed',

        // 帮助
        'help.startAntigravity': 'Start Antigravity',
        'help.retry': 'Retry Connection',
        'help.openLogs': 'Open Logs',

        // User Profile
        'profile.plan': 'Plan',
        'profile.tier': 'Tier',
        'profile.email': 'Email',
        'profile.details': 'Plan Details',
        'feature.browser': 'Browser Access',
        'feature.knowledgeBase': 'Knowledge Base',
        'feature.fastMode': 'Autocomplete Fast Mode',
        'feature.moreCredits': 'Can Buy Credits',
        'feature.flowCredits': 'Monthly Flow Credits',
        'feature.promptCredits': 'Monthly Prompt Credits',
        'feature.enabled': 'Enabled',
        'feature.disabled': 'Disabled',
        'feature.webSearch': 'Web Search',
        'feature.gitCommit': 'Git Commit Gen',
        'feature.mcp': 'MCP Servers',
        'feature.context': 'Context Window',
        'profile.more': 'Show More Details',
        'profile.less': 'Show Less',
        'profile.description': 'Description',
        'profile.upgrade': 'Upgrade Info',
        'profile.teamsTier': 'Teams Tier',
        'profile.userId': 'Internal Tier ID',
        'profile.tabToJump': 'Tab To Jump',
        'profile.stickyModels': 'Sticky Models',
        'profile.commandModels': 'Command Models',
        'profile.maxPremiumMsgs': 'Max Premium Msgs',
        'profile.chatInstructionsCharLimit': 'Chat Instructions Char Limit',
        'profile.pinnedContextItems': 'Pinned Context Items',
        'profile.localIndexSize': 'Local Index Size',
        'profile.acceptedTos': 'Accepted TOS',
        'profile.customizeIcon': 'Customize Icon',
        'profile.cascadeAutoRun': 'Cascade Auto Run',
        'profile.cascadeBackground': 'Cascade Background',
        'profile.autoRunCommands': 'Auto Run Commands',
        'profile.expBrowserFeatures': 'Exp. Browser Features',
        'profile.hide': 'Hide Plan Details',
        'profile.show': 'Show Plan Details',
        'profile.hideData': 'Hide Data',
        'profile.showData': 'Show Data',
        // Grouping
        'grouping.title': 'Quota Groups',
        'grouping.enable': 'Enable Grouping',
        'grouping.disable': 'Disable Grouping',
        'grouping.rename': 'Rename Group',
        'grouping.renamePrompt': 'Enter new name for this group:',
        'grouping.models': 'Models',
        'grouping.showInStatusBar': 'Show Groups in Status Bar',
        'grouping.toggleHint': 'Toggle group view',
        'grouping.autoGroup': 'Auto Group',
        'grouping.autoGroupHint': 'Recalculate groups based on current quota',
        // Model Rename
        'model.rename': 'Rename Model',
        'model.renamePrompt': 'Enter new name for this model:',
        'model.renamed': 'Model renamed to {name}',
        'model.nameEmpty': 'Name cannot be empty',
        'model.reset': 'Reset',
        // Status Bar Format
        'statusBarFormat.title': 'Status Bar Style',
        'statusBarFormat.icon': 'Icon Only',
        'statusBarFormat.iconDesc': '🚀',
        'statusBarFormat.dot': 'Status Dot',
        'statusBarFormat.dotDesc': '🟢 | 🟡 | 🔴',
        'statusBarFormat.percent': 'Percent Only',
        'statusBarFormat.percentDesc': '95%',
        'statusBarFormat.compact': 'Dot + Percent',
        'statusBarFormat.compactDesc': '🟢 95%',
        'statusBarFormat.namePercent': 'Name + Percent',
        'statusBarFormat.namePercentDesc': 'Sonnet: 95%',
        'statusBarFormat.standard': 'Full (Default)',
        'statusBarFormat.standardDesc': '🟢 Sonnet: 95%',
        'statusBarFormat.changed': 'Status bar: {format}',
        // Feedback & Settings
        'feedback.title': 'Feedback',
        'feedback.report': 'Report Issue',
        'feedback.hint': 'Report issues or suggest features',
        // Threshold Settings
        'threshold.warning': 'Warning Threshold',
        'threshold.critical': 'Critical Threshold',
        'threshold.settings': 'Settings',
        'threshold.enableNotification': 'Enable Notifications',
        'threshold.enableNotificationHint': 'Show popup alerts when quota drops below thresholds',
        'threshold.warningHint': 'Quota below this shows yellow warning',
        'threshold.criticalHint': 'Quota below this shows red danger alert',
        'threshold.setWarning': 'Set warning threshold (current: {value}%)',
        'threshold.setCritical': 'Set critical threshold (current: {value}%)',
        'threshold.inputWarning': 'Enter warning threshold (5-80)',
        'threshold.inputCritical': 'Enter critical threshold (1-50)',
        'threshold.updated': 'Threshold updated to {value}%',
        'threshold.invalid': 'Invalid value. Please enter a number between {min} and {max}.',
        'notification.enabled': 'Notifications enabled',
        'notification.disabled': 'Notifications disabled',
        'threshold.notifyWarning': '⚠️ {model} quota is low ({percent}%)',
        'threshold.notifyCritical': '🚨 {model} quota is critically low ({percent}%)!',
        // Offline Status
        'offline.lastUpdate': 'Last Update',
        'offline.lastUpdateAgo': 'Last updated {time} ago',
        'offline.justNow': 'just now',
        'offline.minutesAgo': '{count}m ago',
        'offline.hoursAgo': '{count}h ago',
        // Error messages
        'error.invalidResponse': 'Invalid server response: {details}',
        // QuickPick mode
        'quickpick.placeholder': 'Click a model to toggle status bar pinning',
        'quickpick.quotaSection': 'Model Quotas',
        'quickpick.actionsSection': 'Actions',
        'quickpick.noData': 'No quota data',
        'quickpick.openSettings': 'Open Settings',
        'quickpick.switchToWebview': 'Switch to Webview Mode',
        'quickpick.switchedToWebview': 'Switched to Webview mode.',
        // Webview fallback
        'webview.failedPrompt': 'Failed to load Webview. Switch to QuickPick compatibility mode?',
        'webview.switchToQuickPick': 'Switch',
        'webview.cancel': 'Cancel',
        'webview.switchedToQuickPick': 'Switched to QuickPick mode. Click status bar to view quotas.',
    },
    'zh-cn': {
        // 状态栏
        'statusBar.init': '配额监控: 初始化...',
        'statusBar.connecting': '配额监控: 连接中...',
        'statusBar.ready': '配额监控: 就绪',
        'statusBar.offline': '配额监控: 离线',
        'statusBar.error': '配额监控: 错误',
        'statusBar.failure': '配额监控故障',
        'statusBar.lowest': '最低',
        'statusBar.credits': '积分',
        'statusBar.tooltip': '点击打开配额监控面板',

        // Dashboard
        'dashboard.title': 'Antigravity 配额监控',
        'dashboard.connecting': '正在连接...',
        'dashboard.offline': '系统离线',
        'dashboard.offlineDesc': '未检测到 Antigravity 进程，请确保 Antigravity 正在运行。',
        'dashboard.refresh': '刷新',
        'dashboard.refreshing': '刷新中...',
        'dashboard.showCredits': '显示积分',
        'dashboard.promptCredits': 'Prompt 积分',
        'dashboard.available': '可用',
        'dashboard.monthly': '每月额度',
        'dashboard.resetIn': '重置倒计时',
        'dashboard.resetTime': '重置时间',
        'dashboard.status': '状态',
        'dashboard.exhausted': '已耗尽',
        'dashboard.active': '健康',
        'dashboard.warning': '警告',
        'dashboard.danger': '危险',
        'dashboard.online': '已恢复',
        'dashboard.dragHint': '拖拽排序',
        'dashboard.pinHint': '固定到状态栏',
        'dashboard.resetOrder': '重置排序',
        'profile.planDetails': '计划',
        'profile.togglePlan': '切换计划详情显示',
        'dashboard.offlineHint': '请重试连接。',

        // 通知
        'notify.refreshing': '正在刷新配额数据...',
        'notify.refreshed': '配额数据已刷新',
        'notify.exhausted': '{model} 配额已耗尽！将在 {time} 后重置',
        'notify.warning': '{model} 配额不足 ({percent}%)',
        'notify.offline': '配额监控: 系统离线，未检测到 Antigravity 进程。',
        'notify.bootFailed': '配额监控: 启动失败',

        // 帮助
        'help.startAntigravity': '启动 Antigravity',
        'help.retry': '重试连接',
        'help.openLogs': '查看日志',

        // User Profile
        'profile.plan': '计划',
        'profile.tier': '等级',
        'profile.email': '邮箱',
        'profile.details': '计划详情',
        'feature.browser': '浏览器访问',
        'feature.knowledgeBase': '知识库',
        'feature.fastMode': '自动补全极速模式',
        'feature.moreCredits': '购买积分',
        'feature.flowCredits': '每月 Flow 积分',
        'feature.promptCredits': '每月 Prompt 积分',
        'feature.enabled': '已启用',
        'feature.disabled': '未启用',
        'feature.webSearch': '联网搜索',
        'feature.gitCommit': 'Git 提交生成',
        'feature.mcp': 'MCP 服务',
        'feature.context': '上下文长度',
        'profile.more': '显示更多详情',
        'profile.less': '收起详情',
        'profile.description': '套餐描述',
        'profile.upgrade': '升级信息',
        'profile.teamsTier': '团队层级',
        'profile.userId': '用户 ID',
        'profile.tabToJump': 'Tab 跳转',
        'profile.stickyModels': '置顶高级模型',
        'profile.commandModels': '命令模型',
        'profile.maxPremiumMsgs': '高级消息上限',
        'profile.chatInstructionsCharLimit': '自定义指令长度',
        'profile.pinnedContextItems': '固定上下文项',
        'profile.localIndexSize': '本地索引大小',
        'profile.acceptedTos': '已接受服务条款',
        'profile.customizeIcon': '自定义图标',
        'profile.cascadeAutoRun': 'Cascade 自动运行',
        'profile.cascadeBackground': '后台 Cascade',
        'profile.autoRunCommands': '自动运行命令',
        'profile.expBrowserFeatures': '实验性浏览器功能',
        'profile.hide': '隐藏计划详情',
        'profile.show': '显示计划详情',
        'profile.hideData': '隐藏数据',
        'profile.showData': '显示数据',
        // Grouping
        'grouping.title': '配额分组',
        'grouping.enable': '开启分组',
        'grouping.disable': '关闭分组',
        'grouping.rename': '重命名分组',
        'grouping.renamePrompt': '请输入新的分组名称:',
        'grouping.models': '包含模型',
        'grouping.showInStatusBar': '在状态栏显示分组',
        'grouping.toggleHint': '切换分组视图',
        'grouping.autoGroup': '自动分组',
        'grouping.autoGroupHint': '根据当前配额重新计算分组',
        // Model Rename
        'model.rename': '重命名模型',
        'model.renamePrompt': '请输入新的模型名称:',
        'model.renamed': '模型已重命名为 {name}',
        'model.nameEmpty': '名称不能为空',
        'model.reset': '重置',
        // Status Bar Format
        'statusBarFormat.title': '状态栏样式',
        'statusBarFormat.icon': '仅图标',
        'statusBarFormat.iconDesc': '🚀',
        'statusBarFormat.dot': '仅状态球',
        'statusBarFormat.dotDesc': '🟢 | 🟡 | 🔴',
        'statusBarFormat.percent': '仅数字',
        'statusBarFormat.percentDesc': '95%',
        'statusBarFormat.compact': '状态球+数字',
        'statusBarFormat.compactDesc': '🟢 95%',
        'statusBarFormat.namePercent': '名称+数字',
        'statusBarFormat.namePercentDesc': 'Sonnet: 95%',
        'statusBarFormat.standard': '完整显示 (默认)',
        'statusBarFormat.standardDesc': '🟢 Sonnet: 95%',
        'statusBarFormat.changed': '状态栏已切换: {format}',
        // Feedback & Settings
        'feedback.title': '反馈',
        'feedback.report': '报告问题',
        'feedback.hint': '报告问题或建议功能',
        // Threshold Settings
        'threshold.warning': '警告阈值',
        'threshold.critical': '危险阈值',
        'threshold.settings': '设置',
        'threshold.enableNotification': '启用弹窗通知',
        'threshold.enableNotificationHint': '当配额低于阈值时显示弹窗提醒',
        'threshold.warningHint': '配额低于此值时显示黄色警告',
        'threshold.criticalHint': '配额低于此值时显示红色危险提示',
        'threshold.setWarning': '设置警告阈值 (当前: {value}%)',
        'threshold.setCritical': '设置危险阈值 (当前: {value}%)',
        'threshold.inputWarning': '请输入警告阈值 (5-80)',
        'threshold.inputCritical': '请输入危险阈值 (1-50)',
        'threshold.updated': '阈值已更新为 {value}%',
        'threshold.invalid': '无效的值。请输入 {min} 到 {max} 之间的数字。',
        'notification.enabled': '弹窗通知已启用',
        'notification.disabled': '弹窗通知已关闭',
        'threshold.notifyWarning': '⚠️ {model} 配额较低 ({percent}%)',
        'threshold.notifyCritical': '🚨 {model} 配额严重不足 ({percent}%)！',
        // Offline Status
        'offline.lastUpdate': '最后更新',
        'offline.lastUpdateAgo': '最后更新于 {time}',
        'offline.justNow': '刚刚',
        'offline.minutesAgo': '{count}分钟前',
        'offline.hoursAgo': '{count}小时前',
        // Error messages
        'error.invalidResponse': '服务器响应无效: {details}',
        // QuickPick mode
        'quickpick.placeholder': '点击模型可切换状态栏固定',
        'quickpick.quotaSection': '模型配额',
        'quickpick.actionsSection': '操作',
        'quickpick.noData': '暂无配额数据',
        'quickpick.openSettings': '打开设置',
        'quickpick.switchToWebview': '切换到 Webview 模式',
        'quickpick.switchedToWebview': '已切换到 Webview 模式。',
        // Webview fallback
        'webview.failedPrompt': 'Webview 加载失败，是否切换到 QuickPick 兼容模式？',
        'webview.switchToQuickPick': '切换',
        'webview.cancel': '取消',
        'webview.switchedToQuickPick': '已切换到 QuickPick 模式，点击状态栏查看配额。',
    },
    'zh-tw': {
        // 狀態列
        'statusBar.init': '配額監控: 初始化中...',
        'statusBar.connecting': '配額監控: 連線中...',
        'statusBar.ready': '配額監控: 就緒',
        'statusBar.offline': '配額監控: 離線',
        'statusBar.error': '配額監控: 錯誤',
        'statusBar.failure': '配額監控故障',
        'statusBar.lowest': '最低',
        'statusBar.credits': '點數',
        'statusBar.tooltip': '點擊開啟配額監控面板',

        // Dashboard
        'dashboard.title': 'Antigravity 配額監控',
        'dashboard.connecting': '連線中...',
        'dashboard.offline': '系統離線',
        'dashboard.offlineDesc': '未偵測到 Antigravity 處理程序，請確保 Antigravity 正在執行。',
        'dashboard.refresh': '重新整理',
        'dashboard.refreshing': '重新整理中...',
        'dashboard.showCredits': '顯示提示點數',
        'dashboard.promptCredits': 'Prompt 點數',
        'dashboard.available': '可用',
        'dashboard.monthly': '每月額度',
        'dashboard.resetIn': '重置倒數',
        'dashboard.resetTime': '重置時間',
        'dashboard.status': '狀態',
        'dashboard.exhausted': '已耗盡',
        'dashboard.active': '健康',
        'dashboard.warning': '警告',
        'dashboard.danger': '危險',
        'dashboard.online': '已恢復',
        'dashboard.dragHint': '拖曳以重新排序',
        'dashboard.pinHint': '釘選到狀態列',
        'dashboard.resetOrder': '重置排序',
        'profile.planDetails': '方案',
        'profile.togglePlan': '切換方案詳情顯示',
        'dashboard.offlineHint': '請使用狀態列按鈕重試連線。',

        // 通知
        'notify.refreshing': '正在重新整理配額資料...',
        'notify.refreshed': '配額資料已重新整理',
        'notify.exhausted': '{model} 配額已耗盡！將在 {time} 後重置',
        'notify.warning': '{model} 配額不足 ({percent}%)',
        'notify.offline': '配額監控: 系統離線，未偵測到 Antigravity 處理程序。',
        'notify.bootFailed': '配額監控: 啟動失敗',

        // 幫助
        'help.startAntigravity': '啟動 Antigravity',
        'help.retry': '重試連線',
        'help.openLogs': '檢視記錄',

        // User Profile
        'profile.plan': '方案',
        'profile.tier': '等級',
        'profile.email': '電子郵件',
        'profile.details': '方案詳情',
        'feature.browser': '瀏覽器存取',
        'feature.knowledgeBase': '知識庫',
        'feature.fastMode': '自動完成快速模式',
        'feature.moreCredits': '可購買點數',
        'feature.flowCredits': '每月 Flow 點數',
        'feature.promptCredits': '每月 Prompt 點數',
        'feature.enabled': '已啟用',
        'feature.disabled': '未啟用',
        'feature.webSearch': '網路搜尋',
        'feature.gitCommit': 'Git 提交產生',
        'feature.mcp': 'MCP 伺服器',
        'feature.context': '上下文視窗',
        'profile.more': '顯示更多詳情',
        'profile.less': '收起詳情',
        'profile.description': '方案說明',
        'profile.upgrade': '升級資訊',
        'profile.teamsTier': '團隊層級',
        'profile.userId': '內部層級 ID',
        'profile.tabToJump': 'Tab 跳轉',
        'profile.stickyModels': '置頂模型',
        'profile.commandModels': '命令模型',
        'profile.maxPremiumMsgs': '進階訊息上限',
        'profile.chatInstructionsCharLimit': '聊天指令字元限制',
        'profile.pinnedContextItems': '釘選的上下文項目',
        'profile.localIndexSize': '本機索引大小',
        'profile.acceptedTos': '已接受服務條款',
        'profile.customizeIcon': '自訂圖示',
        'profile.cascadeAutoRun': 'Cascade 自動執行',
        'profile.cascadeBackground': '背景 Cascade',
        'profile.autoRunCommands': '自動執行命令',
        'profile.expBrowserFeatures': '實驗性瀏覽器功能',
        'profile.hide': '隱藏方案詳情',
        'profile.show': '顯示方案詳情',
        'profile.hideData': '隱藏資料',
        'profile.showData': '顯示資料',
        // Grouping
        'grouping.title': '配額群組',
        'grouping.enable': '啟用群組',
        'grouping.disable': '停用群組',
        'grouping.rename': '重新命名群組',
        'grouping.renamePrompt': '請輸入新的群組名稱:',
        'grouping.models': '包含模型',
        'grouping.showInStatusBar': '在狀態列顯示群組',
        'grouping.toggleHint': '切換群組檢視',
        'grouping.autoGroup': '自動分組',
        'grouping.autoGroupHint': '根據目前配額重新計算群組',
        // Model Rename
        'model.rename': '重新命名模型',
        'model.renamePrompt': '請輸入新的模型名稱:',
        'model.renamed': '模型已重新命名為 {name}',
        'model.nameEmpty': '名稱不能為空',
        'model.reset': '重置',
        // Status Bar Format
        'statusBarFormat.title': '狀態列樣式',
        'statusBarFormat.icon': '僅圖示',
        'statusBarFormat.iconDesc': '🚀',
        'statusBarFormat.dot': '僅狀態點',
        'statusBarFormat.dotDesc': '🟢 | 🟡 | 🔴',
        'statusBarFormat.percent': '僅百分比',
        'statusBarFormat.percentDesc': '95%',
        'statusBarFormat.compact': '狀態點+百分比',
        'statusBarFormat.compactDesc': '🟢 95%',
        'statusBarFormat.namePercent': '名稱+百分比',
        'statusBarFormat.namePercentDesc': 'Sonnet: 95%',
        'statusBarFormat.standard': '完整顯示 (預設)',
        'statusBarFormat.standardDesc': '🟢 Sonnet: 95%',
        'statusBarFormat.changed': '狀態列已切換: {format}',
        // Feedback & Settings
        'feedback.title': '意見回饋',
        'feedback.report': '回報問題',
        'feedback.hint': '回報問題或建議功能',
        // Threshold Settings
        'threshold.warning': '警告閾值',
        'threshold.critical': '危險閾值',
        'threshold.settings': '設定',
        'threshold.enableNotification': '啟用通知',
        'threshold.enableNotificationHint': '當配額低於閾值時顯示彈出提醒',
        'threshold.warningHint': '配額低於此值時顯示黃色警告',
        'threshold.criticalHint': '配額低於此值時顯示紅色危險提示',
        'threshold.setWarning': '設定警告閾值 (目前: {value}%)',
        'threshold.setCritical': '設定危險閾值 (目前: {value}%)',
        'threshold.inputWarning': '請輸入警告閾值 (5-80)',
        'threshold.inputCritical': '請輸入危險閾值 (1-50)',
        'threshold.updated': '閾值已更新為 {value}%',
        'threshold.invalid': '無效的值。請輸入 {min} 到 {max} 之間的數字。',
        'notification.enabled': '通知已啟用',
        'notification.disabled': '通知已停用',
        'threshold.notifyWarning': '⚠️ {model} 配額較低 ({percent}%)',
        'threshold.notifyCritical': '🚨 {model} 配額嚴重不足 ({percent}%)！',
        // Offline Status
        'offline.lastUpdate': '最後更新',
        'offline.lastUpdateAgo': '最後更新於 {time}',
        'offline.justNow': '剛剛',
        'offline.minutesAgo': '{count} 分鐘前',
        'offline.hoursAgo': '{count} 小時前',
        // Error messages
        'error.invalidResponse': '伺服器回應無效: {details}',
        // QuickPick mode
        'quickpick.placeholder': '點擊模型可切換狀態列釘選',
        'quickpick.quotaSection': '模型配額',
        'quickpick.actionsSection': '操作',
        'quickpick.noData': '暫無配額資料',
        'quickpick.openSettings': '開啟設定',
        'quickpick.switchToWebview': '切換到 Webview 模式',
        'quickpick.switchedToWebview': '已切換到 Webview 模式。',
        // Webview fallback
        'webview.failedPrompt': 'Webview 載入失敗，是否切換到 QuickPick 相容模式？',
        'webview.switchToQuickPick': '切換',
        'webview.cancel': '取消',
        'webview.switchedToQuickPick': '已切換到 QuickPick 模式，點擊狀態列檢視配額。',
    },
};

/** i18n 服务类 */
class I18nService {
    private currentLocale: SupportedLocale = 'en';

    constructor() {
        this.detectLocale();
    }

    /**
     * 检测当前语言环境
     */
    private detectLocale(): void {
        const vscodeLocale = vscode.env.language.toLowerCase();

        if (vscodeLocale.startsWith('zh-tw') || vscodeLocale === 'zh-hant') {
            this.currentLocale = 'zh-tw';
        } else if (vscodeLocale.startsWith('zh')) {
            this.currentLocale = 'zh-cn';
        } else {
            this.currentLocale = 'en';
        }
    }

    /**
     * 获取翻译文本
     * @param key 翻译键
     * @param params 替换参数
     */
    t(key: string, params?: Record<string, string | number>): string {
        const translation = translations[this.currentLocale][key]
            || translations['en'][key]
            || key;

        if (!params) {
            return translation;
        }

        // 替换参数 {param} -> value
        return Object.entries(params).reduce(
            (text, [paramKey, paramValue]) =>
                text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue)),
            translation,
        );
    }

    /**
     * 获取当前语言
     */
    getLocale(): SupportedLocale {
        return this.currentLocale;
    }

    /**
     * 设置语言
     */
    setLocale(locale: SupportedLocale): void {
        this.currentLocale = locale;
    }

    /**
     * 获取所有翻译（用于 Webview）
     */
    getAllTranslations(): TranslationMap {
        return { ...translations['en'], ...translations[this.currentLocale] };
    }
}

// 导出单例
export const i18n = new I18nService();

// 便捷函数
export const t = (key: string, params?: Record<string, string | number>) => i18n.t(key, params);
