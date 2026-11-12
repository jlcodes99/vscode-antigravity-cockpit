/**
 * 模型族识别（自动分组的纯函数层）。
 *
 * 规则：ID 硬编码集合（历史占位 ID）+ 面向未来的版本无关正则
 * （gemini-N-pro-high/low、gemini-N-flash、gemini-N-pro-image）双匹配，
 * 新大版本（Gemini 4/5…）无需改代码即可归族。
 */

export type ModelFamily = 'claude' | 'gemini_pro' | 'gemini_flash' | 'gemini_image';

const GEMINI_PRO_ID_PATTERN = /^gemini-\d+(?:\.\d+)?-pro-(high|low)(?:-|$)/;
const GEMINI_FLASH_ID_PATTERN = /^gemini-\d+(?:\.\d+)?-flash(?:-|$)/;
const GEMINI_IMAGE_ID_PATTERN = /^gemini-\d+(?:\.\d+)?-pro-image(?:-|$)/;

const GEMINI_PRO_LABEL_PATTERN = /^gemini \d+(?:\.\d+)? pro(?:\s*\((high|low)\)|\s+(high|low))(?:\s|$)/;
const GEMINI_FLASH_LABEL_PATTERN = /^gemini \d+(?:\.\d+)? flash\b/;
const GEMINI_IMAGE_LABEL_PATTERN = /^gemini \d+(?:\.\d+)? pro image\b/;

const CLAUDE_ID_SET = new Set(
    [
        'MODEL_CLAUDE_4_5_SONNET',
        'MODEL_CLAUDE_4_5_SONNET_THINKING',
        'MODEL_PLACEHOLDER_M12',
        'MODEL_PLACEHOLDER_M26',
        'MODEL_PLACEHOLDER_M35',
        'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    ].map(id => id.toLowerCase()),
);

const GEMINI_PRO_ID_SET = new Set(
    [
        'MODEL_PLACEHOLDER_M7',
        'MODEL_PLACEHOLDER_M8',
        'MODEL_PLACEHOLDER_M36',
        'MODEL_PLACEHOLDER_M37',
    ].map(id => id.toLowerCase()),
);

const GEMINI_FLASH_ID_SET = new Set(
    [
        'MODEL_PLACEHOLDER_M18',
    ].map(id => id.toLowerCase()),
);

const GEMINI_IMAGE_ID_SET = new Set(
    [
        'MODEL_PLACEHOLDER_M9',
    ].map(id => id.toLowerCase()),
);

export const MODEL_FAMILY_DISPLAY_NAMES: Record<ModelFamily, string> = {
    claude: 'Claude',
    gemini_pro: 'Gemini Pro',
    gemini_flash: 'Gemini Flash',
    gemini_image: 'Gemini Image',
};

export const MODEL_FAMILY_ORDER: ModelFamily[] = ['claude', 'gemini_pro', 'gemini_flash', 'gemini_image'];

function normalizeMatchText(value: string | undefined): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function resolveModelFamily(modelId: string, label?: string): ModelFamily | null {
    const normalizedId = modelId.trim().toLowerCase();
    if (!normalizedId) {
        return null;
    }
    const normalizedLabel = normalizeMatchText(label || modelId);

    if (
        GEMINI_IMAGE_ID_SET.has(normalizedId)
        || GEMINI_IMAGE_ID_PATTERN.test(normalizedId)
        || GEMINI_IMAGE_LABEL_PATTERN.test(normalizedLabel)
    ) {
        return 'gemini_image';
    }

    if (
        GEMINI_PRO_ID_SET.has(normalizedId)
        || GEMINI_PRO_ID_PATTERN.test(normalizedId)
        || GEMINI_PRO_LABEL_PATTERN.test(normalizedLabel)
    ) {
        return 'gemini_pro';
    }

    if (
        GEMINI_FLASH_ID_SET.has(normalizedId)
        || GEMINI_FLASH_ID_PATTERN.test(normalizedId)
        || GEMINI_FLASH_LABEL_PATTERN.test(normalizedLabel)
    ) {
        return 'gemini_flash';
    }

    if (
        CLAUDE_ID_SET.has(normalizedId)
        || normalizedId.startsWith('claude-')
        || normalizedId.startsWith('model_claude')
        || normalizedLabel.startsWith('claude ')
    ) {
        return 'claude';
    }

    return null;
}

/**
 * 根据已有分组映射推断每个族当前使用的 groupId（多数票）。
 * 用于把新模型自动并入已存在的同族组。
 */
export function buildFamilyGroupMap(
    groupMappings: Record<string, string>,
    resolveFamily: (modelId: string) => ModelFamily | null,
): Partial<Record<ModelFamily, string>> {
    const familyStats = new Map<ModelFamily, Map<string, number>>();

    for (const [modelId, groupId] of Object.entries(groupMappings)) {
        if (!groupId) {
            continue;
        }
        const family = resolveFamily(modelId);
        if (!family) {
            continue;
        }
        let groupCounter = familyStats.get(family);
        if (!groupCounter) {
            groupCounter = new Map<string, number>();
            familyStats.set(family, groupCounter);
        }
        groupCounter.set(groupId, (groupCounter.get(groupId) || 0) + 1);
    }

    const familyGroupMap: Partial<Record<ModelFamily, string>> = {};
    for (const family of MODEL_FAMILY_ORDER) {
        const groupCounter = familyStats.get(family);
        if (!groupCounter || groupCounter.size === 0) {
            continue;
        }
        let selectedGroupId: string | null = null;
        let maxCount = -1;
        for (const [groupId, count] of groupCounter.entries()) {
            if (count > maxCount) {
                selectedGroupId = groupId;
                maxCount = count;
            }
        }
        if (selectedGroupId) {
            familyGroupMap[family] = selectedGroupId;
        }
    }

    return familyGroupMap;
}

export interface SmartGroupingResult {
    groupMappings: Record<string, string>;
    groupNames: Record<string, string>;
}

/**
 * 计算"自动分组"结果（族匹配 + 固定组名）。
 * 无法归族的模型不出现在映射中（由调用方决定独立成组或隐藏）。
 */
export function calculateSmartGrouping(
    models: ReadonlyArray<{ modelId: string; label?: string }>,
): SmartGroupingResult {
    const familyBuckets = new Map<ModelFamily, string[]>();
    for (const model of models) {
        const family = resolveModelFamily(model.modelId, model.label);
        if (!family) {
            continue;
        }
        if (!familyBuckets.has(family)) {
            familyBuckets.set(family, []);
        }
        familyBuckets.get(family)!.push(model.modelId);
    }

    const groupMappings: Record<string, string> = {};
    const groupNames: Record<string, string> = {};

    for (const family of MODEL_FAMILY_ORDER) {
        const modelIds = familyBuckets.get(family);
        if (!modelIds || modelIds.length === 0) {
            continue;
        }

        const uniqueModelIds = Array.from(new Set(modelIds)).sort();
        const stableGroupId = uniqueModelIds.join('_');
        const groupName = MODEL_FAMILY_DISPLAY_NAMES[family];

        for (const modelId of uniqueModelIds) {
            groupMappings[modelId] = stableGroupId;
            groupNames[modelId] = groupName;
        }
    }

    return { groupMappings, groupNames };
}
