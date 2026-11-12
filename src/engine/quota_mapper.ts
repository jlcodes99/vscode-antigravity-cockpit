/**
 * 配额响应 → ModelQuotaInfo 的纯映射层（authorized API + 本地进程 API 两条链路）。
 * 不含 IO/日志/i18n 依赖：展示文案通过 labels 注入，异常通过 onWarn 回调上抛。
 */

import {
    ClientModelConfig,
    ClientModelSort,
    ModelQuotaInfo,
} from '../shared/types';
import {
    resolveAuthorizedOrderedModelKeys,
    AuthorizedQuotaResponse,
} from './model_catalog';

export interface QuotaLabels {
    unknown: string;
    online: string;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatIsoLocal(d: Date): string {
    const dateStr = d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const timeStr = d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    return `${dateStr} ${timeStr}`;
}

/**
 * 倒计时格式化：
 * - < 60 分钟: Xm；< 24 小时: Xh Ym；>= 24 小时: Xd Yh Zm
 * - <= 0 返回 null（调用方展示"在线/有配额"文案）
 */
export function formatCountdown(ms: number): string | null {
    if (ms <= 0) {
        return null;
    }
    const totalMinutes = Math.ceil(ms / 60000);
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    if (totalHours < 24) {
        return `${totalHours}h ${remainingMinutes}m`;
    }
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
}

function toPercentage(fraction: number | undefined): number | undefined {
    return fraction !== undefined ? fraction * 100 : undefined;
}

/**
 * authorized 配额接口响应 → 模型列表（按官方排序，排序表外模型追加在末尾）。
 * @param blacklistIds 需隐藏的 model 常量 ID（内部实验/tab 补全/旧别名）
 */
export function mapAuthorizedResponseToModels(
    data: AuthorizedQuotaResponse,
    labels: QuotaLabels,
    onWarn?: (message: string) => void,
    now: number = Date.now(),
    blacklistIds?: ReadonlySet<string>,
): ModelQuotaInfo[] {
    const models: ModelQuotaInfo[] = [];
    if (!data.models) {
        return models;
    }

    for (const modelKey of resolveAuthorizedOrderedModelKeys(data, blacklistIds)) {
        const info = data.models[modelKey];
        if (!info) {
            continue;
        }

        const quotaInfo = info.quotaInfo;
        const rawFraction = quotaInfo?.remainingFraction;
        const remainingFraction = typeof rawFraction === 'number' && rawFraction >= 0 && rawFraction <= 1
            ? rawFraction
            : undefined;

        let resetTime = new Date(0);
        let resetTimeValid = false;
        if (quotaInfo?.resetTime) {
            const parsed = new Date(quotaInfo.resetTime);
            if (!Number.isNaN(parsed.getTime())) {
                resetTime = parsed;
                resetTimeValid = parsed.getTime() > now;
            } else {
                onWarn?.(`[AuthorizedQuota] Invalid resetTime for model ${modelKey}: ${quotaInfo.resetTime}`);
            }
        }

        const timeUntilReset = resetTimeValid ? Math.max(0, resetTime.getTime() - now) : 0;
        const modelId = info.model || modelKey;
        const label = info.displayName?.trim() || modelKey;

        models.push({
            label,
            modelId,
            remainingFraction,
            remainingPercentage: toPercentage(remainingFraction),
            isExhausted: remainingFraction === 0,
            resetTime,
            resetTimeDisplay: resetTimeValid ? formatIsoLocal(resetTime) : labels.unknown,
            timeUntilReset,
            timeUntilResetFormatted: resetTimeValid
                ? (formatCountdown(timeUntilReset) ?? labels.online)
                : labels.online,
            resetTimeValid,
            supportsImages: info.supportsImages,
            isRecommended: info.recommended,
            tagTitle: info.tagTitle,
            supportedMimeTypes: info.supportedMimeTypes,
        });
    }

    return models;
}

/** 本地进程 clientModelConfigs → 模型列表，并按 clientModelSorts 排序。 */
export function mapLocalConfigsToModels(
    configs: ClientModelConfig[],
    modelSorts: ClientModelSort[] | undefined,
    labels: QuotaLabels,
    onWarn?: (message: string) => void,
    now: number = Date.now(),
): ModelQuotaInfo[] {
    const sortOrderMap = new Map<string, number>();
    if (modelSorts && modelSorts.length > 0) {
        let index = 0;
        for (const group of modelSorts[0].groups) {
            for (const label of group.modelLabels) {
                sortOrderMap.set(label, index++);
            }
        }
    }

    const models: ModelQuotaInfo[] = configs
        .filter((m): m is ClientModelConfig & { quotaInfo: NonNullable<ClientModelConfig['quotaInfo']> } =>
            !!m.quotaInfo,
        )
        .map((m) => {
            let reset = new Date(m.quotaInfo.resetTime);
            let resetTimeValid = true;
            if (Number.isNaN(reset.getTime())) {
                reset = new Date(now + MS_PER_DAY);
                resetTimeValid = false;
                onWarn?.(`[ReactorCore] Invalid resetTime for model ${m.label}: ${m.quotaInfo.resetTime}`);
            }
            const delta = reset.getTime() - now;
            const fraction = m.quotaInfo.remainingFraction;

            return {
                label: m.label,
                modelId: m.modelOrAlias?.model || 'unknown',
                remainingFraction: fraction,
                remainingPercentage: toPercentage(fraction),
                isExhausted: fraction === 0,
                resetTime: reset,
                resetTimeDisplay: resetTimeValid ? formatIsoLocal(reset) : labels.unknown,
                timeUntilReset: delta,
                timeUntilResetFormatted: resetTimeValid
                    ? (formatCountdown(delta) ?? labels.online)
                    : labels.unknown,
                resetTimeValid,
                supportsImages: m.supportsImages,
                isRecommended: m.isRecommended,
                tagTitle: m.tagTitle,
                supportedMimeTypes: m.supportedMimeTypes,
            };
        });

    models.sort((a, b) => {
        const indexA = sortOrderMap.get(a.label);
        const indexB = sortOrderMap.get(b.label);
        if (indexA !== undefined && indexB !== undefined) {
            return indexA - indexB;
        }
        if (indexA !== undefined) {
            return -1;
        }
        if (indexB !== undefined) {
            return 1;
        }
        return a.label.localeCompare(b.label);
    });

    return models;
}
