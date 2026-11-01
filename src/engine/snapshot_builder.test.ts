import { ModelQuotaInfo } from '../shared/types';
import { assembleSnapshotModels } from './snapshot_builder';

function makeModel(overrides: Partial<ModelQuotaInfo> & { modelId: string }): ModelQuotaInfo {
    return {
        label: overrides.modelId,
        isExhausted: false,
        resetTime: new Date('2030-01-01T00:00:00Z'),
        timeUntilReset: 3600_000,
        timeUntilResetFormatted: '1h',
        resetTimeDisplay: '2030-01-01 00:00',
        remainingFraction: 0.5,
        remainingPercentage: 50,
        ...overrides,
    };
}

const defaultConfig = {
    groupingEnabled: false,
    groupMappings: {},
    groupingCustomNames: {},
    visibleModels: [],
};

describe('assembleSnapshotModels — visible filter', () => {
    it('visibleModels 为空时不过滤', () => {
        const models = [makeModel({ modelId: 'A' }), makeModel({ modelId: 'B' })];
        const result = assembleSnapshotModels(models, defaultConfig);
        expect(result.models.map(m => m.modelId)).toEqual(['A', 'B']);
        expect(result.resetVisibleModels).toBe(false);
    });

    it('只保留 visibleModels 中的模型', () => {
        const models = [makeModel({ modelId: 'A' }), makeModel({ modelId: 'B' })];
        const result = assembleSnapshotModels(models, { ...defaultConfig, visibleModels: ['B'] });
        expect(result.models.map(m => m.modelId)).toEqual(['B']);
    });

    it('过滤后为空时要求重置可见列表，并回退为全部展示', () => {
        const models = [makeModel({ modelId: 'A' }), makeModel({ modelId: 'B' })];
        const result = assembleSnapshotModels(models, { ...defaultConfig, visibleModels: ['GONE'] });
        expect(result.resetVisibleModels).toBe(true);
        expect(result.models.map(m => m.modelId)).toEqual(['A', 'B']);
    });

    it('不修改输入数组', () => {
        const models = [makeModel({ modelId: 'A' }), makeModel({ modelId: 'B' })];
        assembleSnapshotModels(models, { ...defaultConfig, visibleModels: ['A'] });
        expect(models).toHaveLength(2);
    });
});

describe('assembleSnapshotModels — grouping', () => {
    it('groupingEnabled=false 时 groups 为 undefined', () => {
        const models = [makeModel({ modelId: 'gemini-4-pro-high' })];
        expect(assembleSnapshotModels(models, defaultConfig).groups).toBeUndefined();
    });

    it('按保存的映射分组', () => {
        const models = [
            makeModel({ modelId: 'gemini-4-pro-high', remainingFraction: 0.9, remainingPercentage: 90 }),
            makeModel({ modelId: 'gemini-4-pro-low', remainingFraction: 0.9, remainingPercentage: 90 }),
        ];
        const result = assembleSnapshotModels(models, {
            ...defaultConfig,
            groupingEnabled: true,
            groupMappings: { 'gemini-4-pro-high': 'g1', 'gemini-4-pro-low': 'g1' },
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups?.[0].models.map(m => m.modelId).sort()).toEqual([
            'gemini-4-pro-high',
            'gemini-4-pro-low',
        ]);
        expect(result.groups?.[0].remainingPercentage).toBe(90);
    });

    it('组内配额签名与多数派不一致的模型被移出并回传 removedMappingIds', () => {
        const sameReset = new Date('2030-01-01T00:00:00Z');
        const otherReset = new Date('2031-01-01T00:00:00Z');
        const models = [
            makeModel({ modelId: 'A', resetTime: sameReset, remainingFraction: 0.9 }),
            makeModel({ modelId: 'B', resetTime: sameReset, remainingFraction: 0.9 }),
            makeModel({ modelId: 'C', resetTime: otherReset, remainingFraction: 0.1 }),
        ];
        const result = assembleSnapshotModels(models, {
            ...defaultConfig,
            groupingEnabled: true,
            groupMappings: { A: 'g1', B: 'g1', C: 'g1' },
        });
        expect(result.removedMappingIds).toEqual(['C']);
        expect(result.groups?.[0].models.map(m => m.modelId)).toEqual(['A', 'B']);
    });

    it('未映射的新模型按族并入已有组', () => {
        const models = [
            makeModel({ modelId: 'gemini-3.1-pro-high' }),
            makeModel({ modelId: 'gemini-4-pro-high' }),
        ];
        const result = assembleSnapshotModels(models, {
            ...defaultConfig,
            groupingEnabled: true,
            groupMappings: { 'gemini-3.1-pro-high': 'g-pro' },
        });
        const proGroup = result.groups?.find(g => g.groupId === 'g-pro');
        expect(proGroup?.models.map(m => m.modelId)).toContain('gemini-4-pro-high');
    });

    it('无法归族且未映射的模型独立成组（保证可见）', () => {
        const models = [makeModel({ modelId: 'FUTURE_UNKNOWN', label: 'Future X' })];
        const result = assembleSnapshotModels(models, {
            ...defaultConfig,
            groupingEnabled: true,
            groupMappings: {},
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups?.[0].groupId).toBe('auto-solo:FUTURE_UNKNOWN');
        expect(result.groups?.[0].groupName).toBe('Future X');
    });

    it('自定义组名多数票生效', () => {
        const models = [
            makeModel({ modelId: 'gemini-4-pro-high' }),
            makeModel({ modelId: 'gemini-4-pro-low' }),
        ];
        const result = assembleSnapshotModels(models, {
            ...defaultConfig,
            groupingEnabled: true,
            groupMappings: { 'gemini-4-pro-high': 'g1', 'gemini-4-pro-low': 'g1' },
            groupingCustomNames: { 'gemini-4-pro-high': 'My Pro' },
        });
        expect(result.groups?.[0].groupName).toBe('My Pro');
    });
});
