/**
 * 状态栏文本的纯逻辑层（无 vscode 依赖，便于单测）。
 *
 * 一个配额组可能同时存在多个配额窗口（如 Gemini 4 Argon 的 5 小时限制 +
 * 周限制）。组级状态栏文本需要在各窗口间明确区分，而不是只显示最低值。
 */

export interface StatusBarQuotaWindow {
    windowId?: string;
    windowName?: string;
    remainingPercentage?: number;
    /** 上游类型允许 string | number（枚举值或序号），统一按字符串匹配 */
    quotaBucketType?: string | number;
}

export type StatusBarFormat =
    | 'icon'
    | 'dot'
    | 'percent'
    | 'compact'
    | 'namePercent'
    | 'standard';

/** 窗口短标签：状态栏空间有限，用紧凑符号区分窗口类型 */
export function formatQuotaWindowShortLabel(window: StatusBarQuotaWindow): string {
    const id = (window.windowId || '').toLowerCase();
    const name = (window.windowName || '').toLowerCase();
    const bucketType = String(window.quotaBucketType ?? '').toLowerCase();
    const text = `${id} ${name} ${bucketType}`;

    if (/(?:^|[^a-z0-9])5h(?:[^a-z0-9]|$)|5[-_ ]?hour|short[-_ ]?term/.test(text)) {
        return '5h';
    }
    if (/long[-_ ]?term|weekly|week/.test(text)) {
        return 'Week';
    }
    if (/monthly|month/.test(text)) {
        return 'Mo';
    }
    // 兜底：截取窗口名开头，避免状态栏出现空白段
    const fallback = (window.windowName || '').trim().slice(0, 5);
    return fallback || 'Q';
}

export interface ResolvedThresholds {
    warningThreshold: number;
    criticalThreshold: number;
}

/** 按阈值取状态球 */
export function statusDotFor(percentage: number, thresholds: ResolvedThresholds): string {
    if (percentage <= thresholds.criticalThreshold) { return '🔴'; }
    if (percentage <= thresholds.warningThreshold) { return '🟡'; }
    return '🟢';
}

function floorPct(percentage: number): string {
    return `${Math.floor(percentage)}%`;
}

/**
 * 生成一个组的完整状态栏文本（多窗口时逐窗口列出）。
 *
 * @param format 状态栏格式
 * @param label 组显示名
 * @param windows 组的配额窗口（组无窗口数据时传 undefined，退化为单值）
 * @param fallbackPercentage 无窗口数据时使用的组百分比
 * @param thresholds 阈值（用于状态球）
 * @returns 状态栏文本段；icon 格式返回 ''（由调用方统一处理）
 */
export function formatGroupStatusText(
    format: StatusBarFormat,
    label: string,
    windows: readonly StatusBarQuotaWindow[] | undefined,
    fallbackPercentage: number,
    thresholds: ResolvedThresholds,
): string {
    if (format === 'icon') {
        return '';
    }

    const resolved = (windows && windows.length > 0
        ? windows.map(window => ({
            shortLabel: formatQuotaWindowShortLabel(window),
            pct: window.remainingPercentage ?? fallbackPercentage,
        }))
        : [{ shortLabel: '', pct: fallbackPercentage }]);

    const minPct = Math.min(...resolved.map(entry => entry.pct));
    const dot = statusDotFor(minPct, thresholds);

    switch (format) {
        case 'dot':
            // 仅状态球：多窗口时显示最紧张的那个
            return dot;
        case 'percent':
            return resolved.map(entry => floorPct(entry.pct)).join(' · ');
        case 'compact':
            return `${dot} ${resolved.map(entry => floorPct(entry.pct)).join(' · ')}`;
        case 'namePercent':
            return resolved.length > 1
                ? `${label}: ${resolved.map(entry => `${entry.shortLabel} ${floorPct(entry.pct)}`).join(' · ')}`
                : `${label}: ${floorPct(minPct)}`;
        case 'standard':
        default:
            return resolved.length > 1
                ? `${dot} ${label}: ${resolved.map(entry => `${entry.shortLabel} ${floorPct(entry.pct)}`).join(' · ')}`
                : `${dot} ${label}: ${floorPct(minPct)}`;
    }
}
