import * as Models from './model_ids';

export const AUTH_RECOMMENDED_LABELS = [
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3 Flash',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
    'Gemini 3 Pro Image',
];

export const AUTH_RECOMMENDED_MODEL_IDS = [
    Models.MODEL_GEMINI_3_1_PRO_HIGH,
    Models.MODEL_GEMINI_3_1_PRO_LOW,
    Models.MODEL_GEMINI_3_FLASH,
    Models.MODEL_CLAUDE_SONNET_4_6_THINKING,
    Models.MODEL_CLAUDE_OPUS_4_6_THINKING,
    Models.MODEL_OPENAI_GPT_OSS_120B_MEDIUM,
    Models.MODEL_GEMINI_3_PRO_IMAGE,
];

// Authorized 模式黑名单（不显示）
export const AUTH_MODEL_BLACKLIST_IDS = [
    Models.MODEL_CHAT_20706,
    Models.MODEL_CHAT_23310,
    Models.MODEL_GOOGLE_GEMINI_2_5_FLASH,
    Models.MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING,
    Models.MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE,
    Models.MODEL_GOOGLE_GEMINI_2_5_PRO,
    Models.MODEL_PLACEHOLDER_M19,
];

// Helper to normalize keys for recommended matching
export function normalizeRecommendedKey(value: string | undefined): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Sets and Ranks for the Engine
export const AUTH_MODEL_BLACKLIST_ID_SET = new Set(AUTH_MODEL_BLACKLIST_IDS.map(id => id.toLowerCase()));

export const AUTH_RECOMMENDED_ID_KEY_RANK: Record<string, number> = {};
AUTH_RECOMMENDED_MODEL_IDS.forEach((id, index) => {
    AUTH_RECOMMENDED_ID_KEY_RANK[id.toLowerCase()] = index;
});

export const AUTH_RECOMMENDED_LABEL_KEY_RANK: Record<string, number> = {};
AUTH_RECOMMENDED_LABELS.forEach((label, index) => {
    AUTH_RECOMMENDED_LABEL_KEY_RANK[normalizeRecommendedKey(label)] = index;
});
