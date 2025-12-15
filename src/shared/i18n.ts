/**
 * Antigravity Cockpit - 国际化支持
 * 简单的 i18n 实现，支持中英文
 */

import * as vscode from 'vscode';

/** 支持的语言 */
export type SupportedLocale = 'en' | 'zh-cn';

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
        // Feedback & Settings
        'feedback.title': 'Feedback',
        'feedback.report': 'Report Issue',
        'feedback.hint': 'Report issues or suggest features',
        // Threshold Settings
        'threshold.warning': 'Warning Threshold',
        'threshold.critical': 'Critical Threshold',
        'threshold.settings': 'Alert Settings',
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
        // Feedback & Settings
        'feedback.title': '反馈',
        'feedback.report': '报告问题',
        'feedback.hint': '报告问题或建议功能',
        // Threshold Settings
        'threshold.warning': '警告阈值',
        'threshold.critical': '危险阈值',
        'threshold.settings': '提醒设置',
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
        
        if (vscodeLocale.startsWith('zh')) {
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
