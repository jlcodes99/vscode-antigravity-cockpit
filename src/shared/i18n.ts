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
        'dashboard.active': 'Active',
        'dashboard.online': 'Restored',
        'dashboard.dragHint': 'Drag to reorder',
        'dashboard.pinHint': 'Pin to Status Bar',

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
        'dashboard.active': '正常',
        'dashboard.online': '已恢复',
        'dashboard.dragHint': '拖拽排序',
        'dashboard.pinHint': '固定到状态栏',

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
