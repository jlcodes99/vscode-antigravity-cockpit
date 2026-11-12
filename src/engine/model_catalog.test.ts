import {
    resolveAuthorizedOrderedModelKeys,
    computeModelAdoption,
    type AuthorizedQuotaResponse,
} from './model_catalog';

describe('resolveAuthorizedOrderedModelKeys', () => {
    const baseModels = {
        M36: { model: 'MODEL_PLACEHOLDER_M36', displayName: 'Gemini 3.1 Pro (Low)' },
        M37: { model: 'MODEL_PLACEHOLDER_M37', displayName: 'Gemini 3.1 Pro (High)' },
    };

    it('按 agentModelSorts 顺序输出', () => {
        const data: AuthorizedQuotaResponse = {
            models: baseModels,
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'M36'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36']);
    });

    it('排序表缺失的新模型（如 Gemini-4）追加到末尾而不是丢弃', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                ...baseModels,
                GEMINI4_PRO_HIGH: { model: 'MODEL_GEMINI_4_PRO_HIGH', displayName: 'Gemini 4 Pro (High)' },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'M36'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36', 'GEMINI4_PRO_HIGH']);
    });

    it('内部实验模型（isInternal，如 chat_20706）即使在排序表外也不输出', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                ...baseModels,
                chat_20706: { model: 'MODEL_CHAT_20706', isInternal: true },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'M36'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36']);
    });

    it('黑名单模型（tab 补全/旧别名，如 M19、2.5 Pro）不输出，即使在排序表中', () => {
        const blacklist = new Set(['MODEL_PLACEHOLDER_M19', 'MODEL_GOOGLE_GEMINI_2_5_PRO']);
        const data: AuthorizedQuotaResponse = {
            models: {
                ...baseModels,
                tab_flash_lite_preview: { model: 'MODEL_PLACEHOLDER_M19' },
                'gemini-2.5-pro': { model: 'MODEL_GOOGLE_GEMINI_2_5_PRO', displayName: 'Gemini 2.5 Pro' },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'tab_flash_lite_preview', 'gemini-2.5-pro', 'M36'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data, blacklist)).toEqual(['M37', 'M36']);
    });

    it('disabled 模型不输出', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                ...baseModels,
                RETIRED: { model: 'MODEL_RETIRED', disabled: true },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'M36'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36']);
    });

    it('排序表引用了不存在的 key 时跳过', () => {
        const data: AuthorizedQuotaResponse = {
            models: baseModels,
            agentModelSorts: [{ groups: [{ modelIds: ['M37', 'GHOST'] }] }],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36']);
    });

    it('排序表为空时返回 models 全部 key', () => {
        const data: AuthorizedQuotaResponse = { models: baseModels, agentModelSorts: [] };
        expect(resolveAuthorizedOrderedModelKeys(data).sort()).toEqual(['M36', 'M37']);
    });

    it('排序表中重复出现的 key 去重', () => {
        const data: AuthorizedQuotaResponse = {
            models: baseModels,
            agentModelSorts: [
                { groups: [{ modelIds: ['M37'] }] },
                { groups: [{ modelIds: ['M37', 'M36'] }] },
            ],
        };
        expect(resolveAuthorizedOrderedModelKeys(data)).toEqual(['M37', 'M36']);
    });

    it('models 缺失时返回空数组', () => {
        expect(resolveAuthorizedOrderedModelKeys({})).toEqual([]);
    });
});

describe('computeModelAdoption', () => {
    it('首次运行仅建立基线，不改可见列表', () => {
        const result = computeModelAdoption({
            currentIds: ['A', 'B'],
            storedIds: undefined,
            visibleIds: ['A'],
        });
        expect(result.nextKnownIds.sort()).toEqual(['A', 'B']);
        expect(result.newIds).toEqual([]);
        expect(result.mergedVisibleIds).toBeNull();
    });

    it('新模型自动并入用户自定义可见列表', () => {
        const result = computeModelAdoption({
            currentIds: ['A', 'GEMINI4'],
            storedIds: ['A'],
            visibleIds: ['A'],
        });
        expect(result.newIds).toEqual(['GEMINI4']);
        expect(result.mergedVisibleIds).toEqual(['A', 'GEMINI4']);
        expect(result.nextKnownIds.sort()).toEqual(['A', 'GEMINI4']);
    });

    it('可见列表为空（全部可见模式）时不写合并列表', () => {
        const result = computeModelAdoption({
            currentIds: ['A', 'GEMINI4'],
            storedIds: ['A'],
            visibleIds: [],
        });
        expect(result.mergedVisibleIds).toBeNull();
    });

    it('黑名单新模型不自动展示', () => {
        const result = computeModelAdoption({
            currentIds: ['A', 'INTERNAL_X'],
            storedIds: ['A'],
            visibleIds: ['A'],
            blacklist: new Set(['INTERNAL_X']),
        });
        expect(result.newIds).toEqual(['INTERNAL_X']);
        expect(result.mergedVisibleIds).toBeNull();
    });

    it('无新模型时返回 null', () => {
        const result = computeModelAdoption({
            currentIds: ['A'],
            storedIds: ['A'],
            visibleIds: ['A'],
        });
        expect(result.newIds).toEqual([]);
        expect(result.mergedVisibleIds).toBeNull();
    });

    it('过滤 unknown 与空字符串并去重', () => {
        const result = computeModelAdoption({
            currentIds: ['A', 'A', 'unknown', ''],
            storedIds: undefined,
            visibleIds: [],
        });
        expect(result.nextKnownIds).toEqual(['A']);
    });
});
