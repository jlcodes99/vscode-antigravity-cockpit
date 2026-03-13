import * as Models from './model_ids';

export interface ModelPreferenceMigrationSummary {
    changed: boolean;
    changedFields: string[];
    replacementCounts: Record<string, number>;
}

export interface ModelPreferenceStateSubset {
    visibleModels?: string[];
    pinnedModels?: string[];
    modelOrder?: string[];
    modelCustomNames?: Record<string, string>;
    groupingCustomNames?: Record<string, string>;
    groupMappings?: Record<string, string>;
}

export interface ModelPreferenceNormalizationResult<T extends ModelPreferenceStateSubset> {
    normalized: T;
    summary: ModelPreferenceMigrationSummary;
}

// 插件内部实际用于过滤/置顶/排序的模型 ID（Authorized response 中 info.model）。
// 覆盖旧模型 -> 新模型 4 个替代关系（Gemini 3 Pro -> 3.1 Pro，Claude 4.5 -> 4.6）。
export const DEPRECATED_MODEL_ID_REPLACEMENTS: Record<string, string> = {
    [Models.MODEL_GEMINI_3_PRO_LOW]: Models.MODEL_GEMINI_3_1_PRO_LOW, // Gemini 3 Pro (Low) -> Gemini 3.1 Pro (Low)
    [Models.MODEL_GEMINI_3_PRO_HIGH]: Models.MODEL_GEMINI_3_1_PRO_HIGH, // Gemini 3 Pro (High) -> Gemini 3.1 Pro (High)
    [Models.MODEL_CLAUDE_4_5_SONNET]: Models.MODEL_CLAUDE_SONNET_4_6_THINKING, // Claude Sonnet 4.5 -> Claude Sonnet 4.6 (Thinking)
    [Models.MODEL_CLAUDE_4_5_SONNET_THINKING]: Models.MODEL_CLAUDE_SONNET_4_6_THINKING, // Claude Sonnet 4.5 (Thinking) -> Claude Sonnet 4.6 (Thinking)
    [Models.MODEL_CLAUDE_OPUS_4_5_THINKING]: Models.MODEL_CLAUDE_OPUS_4_6_THINKING, // Claude Opus 4.5 (Thinking) -> Claude Opus 4.6 (Thinking)
};

// 上游 catalog key（非插件配置主路径，但保留用于调试/兼容扩展）。
export const DEPRECATED_MODEL_KEY_REPLACEMENTS: Record<string, string> = {
    'gemini-3-pro-high': 'gemini-3.1-pro-high',
    'gemini-3-pro-low': 'gemini-3.1-pro-low',
    'claude-sonnet-4-5': 'claude-sonnet-4-6',
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6',
    'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
};

// pinnedModels 历史上理论上可能存 label，因此补一层标签映射兜底（仅用于数组值，不用于对象 key）。
export const DEPRECATED_MODEL_LABEL_REPLACEMENTS: Record<string, string> = {
    'Gemini 3 Pro (High)': 'Gemini 3.1 Pro (High)',
    'Gemini 3 Pro (Low)': 'Gemini 3.1 Pro (Low)',
    'Claude Sonnet 4.5': 'Claude Sonnet 4.6 (Thinking)',
    'Claude Sonnet 4.5 (Thinking)': 'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.5 (Thinking)': 'Claude Opus 4.6 (Thinking)',
};

const ID_REPLACEMENT_LOWER = buildLowerMap(DEPRECATED_MODEL_ID_REPLACEMENTS);
const LABEL_REPLACEMENT_LOWER = buildLowerMap(DEPRECATED_MODEL_LABEL_REPLACEMENTS);

function buildLowerMap(map: Record<string, string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const [from, to] of Object.entries(map)) {
        result.set(from.toLowerCase(), to);
    }
    return result;
}

function incrementReplacement(counter: Map<string, number>, from: string, to: string): void {
    const key = `${from} -> ${to}`;
    counter.set(key, (counter.get(key) ?? 0) + 1);
}

function normalizeValueWithMap(
    value: string,
    replacementMap: Map<string, string>,
    counter: Map<string, number>,
): string {
    let current = value;
    const seen = new Set<string>();

    while (typeof current === 'string' && current.trim()) {
        const key = current.toLowerCase();
        if (seen.has(key)) {
            break;
        }
        seen.add(key);

        const next = replacementMap.get(key);
        if (!next || next === current) {
            break;
        }
        incrementReplacement(counter, current, next);
        current = next;
    }

    return current;
}

function normalizeIdentifierValue(
    value: string,
    counter: Map<string, number>,
    allowLabelReplacement: boolean,
): string {
    const byId = normalizeValueWithMap(value, ID_REPLACEMENT_LOWER, counter);
    if (allowLabelReplacement) {
        return normalizeValueWithMap(byId, LABEL_REPLACEMENT_LOWER, counter);
    }
    return byId;
}

function normalizeArray(
    values: string[] | undefined,
    counter: Map<string, number>,
    allowLabelReplacement = false,
): { value: string[] | undefined; changed: boolean } {
    if (!Array.isArray(values)) {
        return { value: values, changed: false };
    }

    const deduped: string[] = [];
    const seen = new Set<string>();
    let changed = false;

    for (const raw of values) {
        if (typeof raw !== 'string') {
            changed = true;
            continue;
        }
        const normalized = normalizeIdentifierValue(raw, counter, allowLabelReplacement);
        if (normalized !== raw) {
            changed = true;
        }
        const dedupeKey = normalized.toLowerCase();
        if (seen.has(dedupeKey)) {
            changed = true;
            continue;
        }
        seen.add(dedupeKey);
        deduped.push(normalized);
    }

    return { value: deduped, changed };
}

function normalizeModelKeyedRecord(
    record: Record<string, string> | undefined,
    counter: Map<string, number>,
): { value: Record<string, string> | undefined; changed: boolean } {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { value: record, changed: false };
    }

    const next: Record<string, string> = {};
    let changed = false;

    for (const [key, value] of Object.entries(record)) {
        const normalizedKey = normalizeIdentifierValue(key, counter, false);
        if (normalizedKey !== key) {
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(next, normalizedKey)) {
            changed = true;
        }
        next[normalizedKey] = value;
    }

    return { value: next, changed };
}

function normalizeGroupMappings(
    record: Record<string, string> | undefined,
    counter: Map<string, number>,
): { value: Record<string, string> | undefined; changed: boolean } {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { value: record, changed: false };
    }

    const next: Record<string, string> = {};
    let changed = false;

    for (const [modelId, groupId] of Object.entries(record)) {
        const normalizedKey = normalizeIdentifierValue(modelId, counter, false);
        if (normalizedKey !== modelId) {
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(next, normalizedKey) && next[normalizedKey] !== groupId) {
            changed = true;
        }
        next[normalizedKey] = groupId;
    }

    return { value: next, changed };
}

export function normalizeModelPreferenceState<T extends ModelPreferenceStateSubset>(
    input: T,
): ModelPreferenceNormalizationResult<T> {
    const counter = new Map<string, number>();
    const changedFields: string[] = [];
    const normalized: T = { ...input };

    const visibleModels = normalizeArray(input.visibleModels, counter, false);
    if (visibleModels.changed) {
        normalized.visibleModels = visibleModels.value as T['visibleModels'];
        changedFields.push('visibleModels');
    }

    const pinnedModels = normalizeArray(input.pinnedModels, counter, true);
    if (pinnedModels.changed) {
        normalized.pinnedModels = pinnedModels.value as T['pinnedModels'];
        changedFields.push('pinnedModels');
    }

    const modelOrder = normalizeArray(input.modelOrder, counter, false);
    if (modelOrder.changed) {
        normalized.modelOrder = modelOrder.value as T['modelOrder'];
        changedFields.push('modelOrder');
    }

    const modelCustomNames = normalizeModelKeyedRecord(input.modelCustomNames, counter);
    if (modelCustomNames.changed) {
        normalized.modelCustomNames = modelCustomNames.value as T['modelCustomNames'];
        changedFields.push('modelCustomNames');
    }

    const groupingCustomNames = normalizeModelKeyedRecord(input.groupingCustomNames, counter);
    if (groupingCustomNames.changed) {
        normalized.groupingCustomNames = groupingCustomNames.value as T['groupingCustomNames'];
        changedFields.push('groupingCustomNames');
    }

    const groupMappings = normalizeGroupMappings(input.groupMappings, counter);
    if (groupMappings.changed) {
        normalized.groupMappings = groupMappings.value as T['groupMappings'];
        changedFields.push('groupMappings');
    }

    return {
        normalized,
        summary: {
            changed: changedFields.length > 0,
            changedFields,
            replacementCounts: Object.fromEntries(counter.entries()),
        },
    };
}
