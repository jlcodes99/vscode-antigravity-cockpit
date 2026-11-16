import { ModelQuotaInfo, QuotaGroup } from '../shared/types';
import {
    applyCustomGroups,
    buildCustomQuotaGroups,
    pruneGroupMappings,
} from './custom_groups';

function makeModel(modelId: string, overrides: Partial<ModelQuotaInfo> = {}): ModelQuotaInfo {
    return {
        label: modelId,
        modelId,
        isExhausted: false,
        resetTime: new Date('2030-01-01T00:00:00Z'),
        timeUntilReset: 3600_000,
        timeUntilResetFormatted: '1h',
        resetTimeDisplay: '2030-01-01 00:00',
        remainingPercentage: 50,
        ...overrides,
    };
}

function makeOfficialGroup(groupId: string, models: ModelQuotaInfo[]): QuotaGroup {
    return {
        groupId,
        groupName: groupId,
        models,
        remainingPercentage: Math.min(...models.map(m => m.remainingPercentage ?? 0)),
        resetTime: models[0].resetTime,
        resetTimeDisplay: models[0].resetTimeDisplay,
        timeUntilResetFormatted: models[0].timeUntilResetFormatted,
        isExhausted: false,
    };
}

describe('buildCustomQuotaGroups', () => {
    it('无映射时不产生用户分组', () => {
        const result = buildCustomQuotaGroups([makeModel('A')], { groupMappings: {} });
        expect(result.customGroups).toEqual([]);
    });

    it('被映射的模型组成用户分组', () => {
        const models = [makeModel('A'), makeModel('B'), makeModel('C')];
        const result = buildCustomQuotaGroups(models, {
            groupMappings: { A: 'grp1', B: 'grp1' },
            groupNames: { A: 'My Group' },
        });
        expect(result.customGroups).toHaveLength(1);
        expect(result.customGroups[0].models.map(m => m.modelId)).toEqual(['A', 'B']);
        expect(result.customGroups[0].groupName).toBe('My Group');
        expect(result.customGroups[0].groupId.startsWith('custom:')).toBe(true);
    });

    it('未被映射的模型不进入用户分组', () => {
        const models = [makeModel('A'), makeModel('B')];
        const result = buildCustomQuotaGroups(models, { groupMappings: { A: 'grp1' } });
        expect(result.customGroups[0].models.map(m => m.modelId)).toEqual(['A']);
    });

    it('多个用户分组按模型在列表中的顺序排列', () => {
        const models = [makeModel('A'), makeModel('B'), makeModel('C')];
        const result = buildCustomQuotaGroups(models, {
            groupMappings: { B: 'g2', A: 'g1', C: 'g2' },
        });
        expect(result.customGroups.map(g => g.groupId)).toEqual(['custom:g1', 'custom:g2']);
    });

    it('组名缺失时回退为 Group N', () => {
        const result = buildCustomQuotaGroups([makeModel('A')], { groupMappings: { A: 'g1' } });
        expect(result.customGroups[0].groupName).toBe('Group 1');
    });
});

describe('applyCustomGroups', () => {
    it('用户分组优先，官方组保留未接管模型', () => {
        const models = [makeModel('A'), makeModel('B'), makeModel('C')];
        const official = [makeOfficialGroup('official:gemini', [makeModel('A'), makeModel('B')])];
        const { customGroups } = buildCustomQuotaGroups(models, { groupMappings: { A: 'g1' } });

        const groups = applyCustomGroups(official, customGroups);
        expect(groups[0].groupId).toBe('custom:g1');
        expect(groups[0].models.map(m => m.modelId)).toEqual(['A']);
        expect(groups[1].groupId).toBe('official:gemini');
        expect(groups[1].models.map(m => m.modelId)).toEqual(['B']);
    });

    it('官方组模型被全部接管时该组不再展示', () => {
        const official = [makeOfficialGroup('official:gemini', [makeModel('A')])];
        const { customGroups } = buildCustomQuotaGroups([makeModel('A')], { groupMappings: { A: 'g1' } });
        const groups = applyCustomGroups(official, customGroups);
        expect(groups.map(g => g.groupId)).toEqual(['custom:g1']);
    });

    it('无用户分组时官方分组原样返回', () => {
        const official = [makeOfficialGroup('official:x', [makeModel('A')])];
        expect(applyCustomGroups(official, [])).toEqual(official);
    });
});

describe('pruneGroupMappings', () => {
    it('移除指向不存在模型的映射', () => {
        const pruned = pruneGroupMappings({ A: 'g1', GHOST: 'g1' }, [makeModel('A')]);
        expect(pruned).toEqual({ A: 'g1' });
    });

    it('保留有效映射并忽略空 groupId', () => {
        const pruned = pruneGroupMappings({ A: 'g1', B: '' }, [makeModel('A'), makeModel('B')]);
        expect(pruned).toEqual({ A: 'g1' });
    });
});
