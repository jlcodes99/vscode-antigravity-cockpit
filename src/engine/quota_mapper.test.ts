import { ClientModelConfig } from '../shared/types';
import {
    mapAuthorizedResponseToModels,
    mapLocalConfigsToModels,
    formatCountdown,
    QuotaLabels,
} from './quota_mapper';
import type { AuthorizedQuotaResponse } from './model_catalog';

const labels: QuotaLabels = { unknown: 'Unknown', online: 'Online' };
const futureIso = '2099-01-01T00:00:00.000Z';

describe('formatCountdown', () => {
    it('边界与单位', () => {
        expect(formatCountdown(0)).toBeNull();
        expect(formatCountdown(-5)).toBeNull();
        expect(formatCountdown(30 * 60 * 1000)).toBe('30m');
        expect(formatCountdown(2 * 60 * 60 * 1000)).toBe('2h 0m');
        expect(formatCountdown(25 * 60 * 60 * 1000)).toBe('1d 1h 0m');
    });
});

describe('mapAuthorizedResponseToModels', () => {
    it('按排序表顺序映射并转换 fraction→percentage', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                A: { model: 'MODEL_A', displayName: 'A Model', quotaInfo: { remainingFraction: 0.25, resetTime: futureIso } },
                B: { model: 'MODEL_B', displayName: 'B Model', quotaInfo: { remainingFraction: 1, resetTime: futureIso } },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['B', 'A'] }] }],
        };
        const result = mapAuthorizedResponseToModels(data, labels, undefined, 0);
        expect(result.map(m => m.modelId)).toEqual(['MODEL_B', 'MODEL_A']);
        expect(result[1].remainingPercentage).toBe(25);
        expect(result[1].isExhausted).toBe(false);
    });

    it('排序表外的新模型（Gemini-4 场景）追加到末尾', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                A: { model: 'MODEL_A', displayName: 'A' },
                G4: { model: 'MODEL_GEMINI_4', displayName: 'Gemini 4 Pro' },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['A'] }] }],
        };
        const result = mapAuthorizedResponseToModels(data, labels);
        expect(result.map(m => m.modelId)).toEqual(['MODEL_A', 'MODEL_GEMINI_4']);
    });

    it('disabled 模型跳过；越界 fraction 归一为 undefined', () => {
        const data: AuthorizedQuotaResponse = {
            models: {
                A: { model: 'A', displayName: 'A', disabled: true },
                B: { model: 'B', displayName: 'B', quotaInfo: { remainingFraction: 1.5 } },
            },
            agentModelSorts: [{ groups: [{ modelIds: ['A', 'B'] }] }],
        };
        const result = mapAuthorizedResponseToModels(data, labels);
        expect(result.map(m => m.modelId)).toEqual(['B']);
        expect(result[0].remainingFraction).toBeUndefined();
        expect(result[0].isExhausted).toBe(false);
    });

    it('fraction=0 标记耗尽', () => {
        const data: AuthorizedQuotaResponse = {
            models: { A: { model: 'A', displayName: 'A', quotaInfo: { remainingFraction: 0, resetTime: futureIso } } },
            agentModelSorts: [{ groups: [{ modelIds: ['A'] }] }],
        };
        expect(mapAuthorizedResponseToModels(data, labels, undefined, 0)[0].isExhausted).toBe(true);
    });

    it('非法 resetTime 标记无效并用 onWarn 上报', () => {
        const warnings: string[] = [];
        const data: AuthorizedQuotaResponse = {
            models: { A: { model: 'A', displayName: 'A', quotaInfo: { remainingFraction: 0.5, resetTime: 'not-a-date' } } },
            agentModelSorts: [{ groups: [{ modelIds: ['A'] }] }],
        };
        const result = mapAuthorizedResponseToModels(data, labels, msg => warnings.push(msg));
        expect(result[0].resetTimeValid).toBe(false);
        expect(result[0].resetTimeDisplay).toBe('Unknown');
        expect(warnings).toHaveLength(1);
    });

    it('无 models 返回空数组', () => {
        expect(mapAuthorizedResponseToModels({}, labels)).toEqual([]);
    });
});

describe('mapLocalConfigsToModels', () => {
    function config(overrides: Partial<ClientModelConfig> & { label: string }): ClientModelConfig {
        return {
            quotaInfo: { remainingFraction: 0.5, resetTime: futureIso },
            ...overrides,
        };
    }

    it('按 clientModelSorts 的 label 顺序排序，未列入的按字母序', () => {
        const configs = [
            config({ label: 'Charlie' }),
            config({ label: 'Alpha' }),
            config({ label: 'Bravo' }),
        ];
        const result = mapLocalConfigsToModels(
            configs,
            [{ name: 'Recommended', groups: [{ modelLabels: ['Bravo', 'Alpha'] }] }],
            labels,
            undefined,
            0,
        );
        expect(result.map(m => m.label)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    });

    it('过滤无 quotaInfo 的配置', () => {
        const configs = [
            config({ label: 'A' }),
            { label: 'B' } as ClientModelConfig,
        ];
        expect(mapLocalConfigsToModels(configs, [], labels).map(m => m.label)).toEqual(['A']);
    });

    it('非法 resetTime 回退为 +24h 且标记无效', () => {
        const warnings: string[] = [];
        const now = 1_000_000;
        const result = mapLocalConfigsToModels(
            [config({ label: 'A', quotaInfo: { remainingFraction: 0.5, resetTime: 'bad' } })],
            [],
            labels,
            msg => warnings.push(msg),
            now,
        );
        expect(result[0].resetTimeValid).toBe(false);
        expect(result[0].resetTime.getTime()).toBe(now + 24 * 60 * 60 * 1000);
        expect(warnings).toHaveLength(1);
    });
});
