import * as Models from './model_ids';

/**
 * Model Group Families
 */
export type ModelGroupFamily = 'claude' | 'gemini_pro' | 'gemini_flash' | 'gemini_image';

/**
 * Normalizes text for grouping pattern matching
 * - Lowercase
 * - Replaces underscores/dashes with spaces
 * - Collapses multiple spaces
 */
export function normalizeGroupMatchText(value: string | undefined): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Auto-Group ID Patterns
 */
export const AUTO_GROUP_PATTERNS = {
    GEMINI_PRO: /^gemini-\d+(?:\.\d+)?-pro-(high|low)(?:-|$)/,
    GEMINI_FLASH: /^gemini-\d+(?:\.\d+)?-flash(?:-|$)/,
    GEMINI_IMAGE: /^gemini-\d+(?:\.\d+)?-pro-image(?:-|$)/,
};

/**
 * Auto-Group Label Patterns
 */
export const AUTO_GROUP_LABEL_PATTERNS = {
    GEMINI_PRO: /^gemini \d+(?:\.\d+)? pro(?: \((high|low)\)| (high|low))\b/,
    GEMINI_FLASH: /^gemini \d+(?:\.\d+)? flash\b/,
    GEMINI_IMAGE: /^gemini \d+(?:\.\d+)? pro image\b/,
};

/**
 * Auto-Group ID Sets (Static overrides)
 */
export const AUTO_GROUP_ID_SETS: Record<ModelGroupFamily, Set<string>> = {
    claude: new Set([
        Models.MODEL_CLAUDE_4_5_SONNET,
        Models.MODEL_CLAUDE_4_5_SONNET_THINKING,
        Models.MODEL_CLAUDE_OPUS_4_5_THINKING,
        Models.MODEL_CLAUDE_OPUS_4_6_THINKING,
        Models.MODEL_CLAUDE_SONNET_4_6_THINKING,
        Models.MODEL_OPENAI_GPT_OSS_120B_MEDIUM,
    ].map(id => id.toLowerCase())),
    gemini_pro: new Set([
        Models.MODEL_GEMINI_3_PRO_LOW,
        Models.MODEL_GEMINI_3_PRO_HIGH,
        Models.MODEL_GEMINI_3_1_PRO_LOW,
        Models.MODEL_GEMINI_3_1_PRO_HIGH,
    ].map(id => id.toLowerCase())),
    gemini_flash: new Set([
        Models.MODEL_GEMINI_3_FLASH,
    ].map(id => id.toLowerCase())),
    gemini_image: new Set([
        Models.MODEL_GEMINI_3_PRO_IMAGE,
    ].map(id => id.toLowerCase())),
};

/**
 * Resolves the family for a given model ID and label
 */
export function resolveGroupFamily(modelId: string, label?: string): ModelGroupFamily | null {
    const modelIdLower = (modelId || '').toLowerCase();
    const labelText = normalizeGroupMatchText(label || modelId || '');

    // 1. Check ID Sets (Highest priority)
    for (const [family, idSet] of Object.entries(AUTO_GROUP_ID_SETS)) {
        if (idSet.has(modelIdLower)) {
            return family as ModelGroupFamily;
        }
    }

    // 2. Check Gemini Image
    if (AUTO_GROUP_PATTERNS.GEMINI_IMAGE.test(modelIdLower) || AUTO_GROUP_LABEL_PATTERNS.GEMINI_IMAGE.test(labelText)) {
        return 'gemini_image';
    }

    // 3. Check Gemini Pro
    if (AUTO_GROUP_PATTERNS.GEMINI_PRO.test(modelIdLower) || AUTO_GROUP_LABEL_PATTERNS.GEMINI_PRO.test(labelText)) {
        return 'gemini_pro';
    }

    // 4. Check Gemini Flash
    if (AUTO_GROUP_PATTERNS.GEMINI_FLASH.test(modelIdLower) || AUTO_GROUP_LABEL_PATTERNS.GEMINI_FLASH.test(labelText)) {
        return 'gemini_flash';
    }

    // 5. Check Claude
    if (
        modelIdLower.startsWith('claude-') ||
        modelIdLower.startsWith('model_claude') ||
        labelText.startsWith('claude ')
    ) {
        return 'claude';
    }

    return null;
}
