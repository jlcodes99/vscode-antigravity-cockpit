/**
 * 授权配额 API 模型清单解析 —— 纯函数，无外部依赖，便于单测。
 *
 * 关键不变量：官方返回的 models 是单一真相来源。agentModelSorts
 * 只决定展示顺序，当其滞后（如新发布的 Gemini-4 尚未进入排序表）时，
 * 未列出的模型必须追加到末尾，保证新模型可监控。
 */

export interface AuthorizedQuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
}

export interface AuthorizedModelInfo {
    displayName?: string;
    model?: string;
    disabled?: boolean;
    quotaInfo?: AuthorizedQuotaInfo;
    supportsImages?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    thinkingBudget?: number;
    minThinkingBudget?: number;
    maxTokens?: number;
    maxOutputTokens?: number;
    recommended?: boolean;
    tagTitle?: string;
    supportedMimeTypes?: Record<string, boolean>;
    isInternal?: boolean;
}

export interface AuthorizedModelSortGroup {
    modelIds?: string[];
}

export interface AuthorizedModelSort {
    displayName?: string;
    groups?: AuthorizedModelSortGroup[];
}

export interface AuthorizedQuotaResponse {
    models?: Record<string, AuthorizedModelInfo>;
    agentModelSorts?: AuthorizedModelSort[];
}

/**
 * 计算模型展示顺序：先按 agentModelSorts 的官方顺序，
 * 再补入排序表遗漏的模型（API 返回顺序），全部去重。
 */
export function resolveAuthorizedOrderedModelKeys(data: AuthorizedQuotaResponse): string[] {
    const modelMap = data.models;
    if (!modelMap) {
        return [];
    }

    const orderedKeys: string[] = [];
    const added = new Set<string>();

    for (const sort of data.agentModelSorts ?? []) {
        for (const group of sort.groups ?? []) {
            for (const modelIdentifier of group.modelIds ?? []) {
                if (!Object.prototype.hasOwnProperty.call(modelMap, modelIdentifier)) {
                    continue;
                }
                if (added.has(modelIdentifier)) {
                    continue;
                }
                added.add(modelIdentifier);
                orderedKeys.push(modelIdentifier);
            }
        }
    }

    // 兜底：排序表外的模型（官方上线新模型时 sorts 可能滞后）按 API 顺序追加
    for (const modelKey of Object.keys(modelMap)) {
        if (added.has(modelKey)) {
            continue;
        }
        added.add(modelKey);
        orderedKeys.push(modelKey);
    }

    return orderedKeys;
}

export interface ModelAdoptionInput {
    /** 本次 API 返回的全部模型 ID */
    currentIds: string[];
    /** 上次记录的已知模型 ID；首次运行传 undefined */
    storedIds: string[] | undefined;
    /** 用户当前自定义可见列表；空数组代表"全部可见" */
    visibleIds: string[];
    /** 黑名单模型 ID（即使新出现也不自动展示） */
    blacklist?: ReadonlySet<string>;
}

export interface ModelAdoptionResult {
    /** 应持久化的已知模型 ID */
    nextKnownIds: string[];
    /** 新出现的模型 ID */
    newIds: string[];
    /** 合并后的可见列表；无需变更时为 null（调用方不要写配置） */
    mergedVisibleIds: string[] | null;
}

/**
 * 识别官方新上线模型并决定是否自动纳入可见列表。
 * 首次调用仅建立基线；黑名单模型不自动展示。
 */
export function computeModelAdoption(input: ModelAdoptionInput): ModelAdoptionResult {
    const currentIds = Array.from(new Set(
        input.currentIds.filter(id => typeof id === 'string' && id.length > 0 && id !== 'unknown'),
    ));
    const storedIds = input.storedIds ?? [];
    const isFirstRun = input.storedIds === undefined;

    if (isFirstRun) {
        return { nextKnownIds: currentIds, newIds: [], mergedVisibleIds: null };
    }

    const knownSet = new Set(storedIds);
    const newIds = currentIds.filter(id => !knownSet.has(id));
    const nextKnownIds = Array.from(new Set([...storedIds, ...currentIds]));

    if (newIds.length === 0 || input.visibleIds.length === 0) {
        return { nextKnownIds, newIds, mergedVisibleIds: null };
    }

    const blacklist = input.blacklist ?? new Set<string>();
    const adoptable = newIds.filter(id => !blacklist.has(id));
    if (adoptable.length === 0) {
        return { nextKnownIds, newIds, mergedVisibleIds: null };
    }

    const mergedVisibleIds = Array.from(new Set([...input.visibleIds, ...adoptable]));
    return { nextKnownIds, newIds, mergedVisibleIds };
}
