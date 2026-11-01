import {
    resolveModelFamily,
    calculateSmartGrouping,
    buildFamilyGroupMap,
} from './model_family';

describe('resolveModelFamily', () => {
    it('识别历史占位 ID', () => {
        expect(resolveModelFamily('MODEL_PLACEHOLDER_M37')).toBe('gemini_pro');
        expect(resolveModelFamily('model_placeholder_m18')).toBe('gemini_flash');
        expect(resolveModelFamily('MODEL_PLACEHOLDER_M9')).toBe('gemini_image');
        expect(resolveModelFamily('MODEL_CLAUDE_4_5_SONNET')).toBe('claude');
        expect(resolveModelFamily('MODEL_OPENAI_GPT_OSS_120B_MEDIUM')).toBe('claude');
    });

    it('版本无关正则识别 Gemini 3/4/5（新大版本无需改代码）', () => {
        expect(resolveModelFamily('gemini-4-pro-high')).toBe('gemini_pro');
        expect(resolveModelFamily('gemini-4-pro-low')).toBe('gemini_pro');
        expect(resolveModelFamily('gemini-5.2-flash')).toBe('gemini_flash');
        expect(resolveModelFamily('gemini-4-pro-image')).toBe('gemini_image');
        expect(resolveModelFamily('claude-opus-5-1')).toBe('claude');
    });

    it('label 匹配（占位 ID 不在硬编码集合时）', () => {
        expect(resolveModelFamily('MODEL_FUTURE_X', 'Gemini 4 Pro (High)')).toBe('gemini_pro');
        expect(resolveModelFamily('MODEL_FUTURE_X', 'Gemini 4 Flash')).toBe('gemini_flash');
        expect(resolveModelFamily('MODEL_FUTURE_X', 'Gemini 4 Pro Image')).toBe('gemini_image');
        expect(resolveModelFamily('MODEL_FUTURE_X', 'Claude Opus 5')).toBe('claude');
    });

    it('image 优先级高于 pro（gemini-N-pro-image 不应归到 pro）', () => {
        expect(resolveModelFamily('gemini-4-pro-image-exp')).toBe('gemini_image');
    });

    it('无法识别返回 null', () => {
        expect(resolveModelFamily('MODEL_FUTURE_X', 'Unknown Thing')).toBeNull();
        expect(resolveModelFamily('  ')).toBeNull();
    });
});

describe('calculateSmartGrouping', () => {
    it('同族模型映射到同一稳定 groupId 并带固定组名', () => {
        const result = calculateSmartGrouping([
            { modelId: 'gemini-4-pro-high', label: 'Gemini 4 Pro (High)' },
            { modelId: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
        ]);
        const ids = Object.keys(result.groupMappings);
        expect(ids).toHaveLength(2);
        expect(result.groupMappings[ids[0]]).toBe(result.groupMappings[ids[1]]);
        expect(Object.values(result.groupNames)).toEqual(['Gemini Pro', 'Gemini Pro']);
    });

    it('无法归族的模型不进入映射', () => {
        const result = calculateSmartGrouping([
            { modelId: 'RANDOM_MODEL' },
            { modelId: 'gemini-4-flash' },
        ]);
        expect(Object.keys(result.groupMappings)).toEqual(['gemini-4-flash']);
    });
});

describe('buildFamilyGroupMap', () => {
    it('按多数票推断族的 groupId', () => {
        const map = buildFamilyGroupMap(
            {
                a: 'g1', b: 'g1', c: 'g2',
            },
            id => (id === 'c' ? 'gemini_pro' : 'claude'),
        );
        expect(map.claude).toBe('g1');
        expect(map.gemini_pro).toBe('g2');
    });

    it('忽略空 groupId 与无法归族的模型', () => {
        const map = buildFamilyGroupMap(
            { a: '', x: 'g9' },
            id => (id === 'a' ? 'claude' : null),
        );
        expect(map.claude).toBeUndefined();
    });
});
