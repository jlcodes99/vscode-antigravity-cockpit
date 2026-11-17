import { ReactorCore } from './reactor';
import { configService } from '../shared/config_service';
import { ModelQuotaInfo, QuotaSnapshot } from '../shared/types';
import { readDesktopQuotaApiCache, type QuotaApiCacheRecord } from '../services/quota_api_cache';

jest.mock('../shared/log_service', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../shared/i18n', () => ({ t: (key: string) => key }));
jest.mock('../shared/config_service', () => ({ configService: {
    getConfig: jest.fn(() => ({ visibleModels: [] })),
    getStateValue: jest.fn(),
    setStateValue: jest.fn(),
    updateVisibleModels: jest.fn(),
} }));
jest.mock('../auto_trigger/controller', () => ({ autoTriggerController: { setQuotaModels: jest.fn() } }));
jest.mock('../auto_trigger', () => ({ oauthService: {}, credentialStorage: {} }));
jest.mock('../antigravityTools_sync', () => ({ antigravityToolsSyncService: {} }));
jest.mock('../services/quota_api_cache', () => ({
    ...jest.requireActual('../services/quota_api_cache'),
    readQuotaApiCache: jest.fn().mockResolvedValue(null),
    readDesktopQuotaApiCache: jest.fn().mockResolvedValue(null),
}));

const now = Date.UTC(2026, 10, 3, 12);
const hour = 3600000;
const reset = (hours: number) => new Date(now + hours * hour).toISOString();
const argonWeekly = { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Gemini 4 Argon Weekly Limit', remainingFraction: 0.91, resetTime: reset(2) };
const standardGeminiWeekly = { bucketId: 'gemini-weekly', remainingFraction: 0, resetTime: reset(2) };
const response = {
    models: {
        old: { model: 'gemini-pro', displayName: 'Gemini Pro', quotaInfo: { remainingFraction: 0.9, resetTime: reset(1) } },
        added: { model: 'gemini-argon', displayName: 'Gemini Argon', quotaInfo: { remainingFraction: 0.1, resetTime: reset(5) } },
        internal: { model: 'hidden', isInternal: true },
    },
    agentModelSorts: [{ groups: [{ modelIds: ['old'] }] }],
};

function localSnapshot(email?: string): QuotaSnapshot {
    return {
        timestamp: new Date(now), isConnected: true,
        models: [{ modelId: 'local-only', label: 'Gemini Local', resetTime: new Date(reset(5)), remainingPercentage: 23 } as ModelQuotaInfo],
        userInfo: email ? { email } as QuotaSnapshot['userInfo'] : undefined,
    };
}

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.clearAllMocks();
    jest.mocked(configService.getConfig).mockReturnValue({ visibleModels: [] } as unknown as ReturnType<typeof configService.getConfig>);
});
afterEach(() => jest.useRealTimers());

function quotaCache(email: string, payload: unknown): QuotaApiCacheRecord {
    return { version: 1, source: 'authorized', customSource: 'desktop', email, payload, updatedAt: now };
}

test('官方 Argon 周配额独立展示，模型清单缺失也保留该行', () => {
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [standardGeminiWeekly, argonWeekly] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, models: { old: response.models.old }, quota_summary: quotaSummary,
    });
    expect(result.groups?.map(group => [group.groupName, group.remainingPercentage, group.models.length])).toEqual([
        ['Gemini Models', 0, 1], ['Gemini 4 Argon', 91, 0],
    ]);
    expect(result.groups?.[0].quotaWindows?.[0].quotaBucketType).toBe('LONG_TERM');
    expect(result.groups?.[1].quotaWindows?.[0]).toMatchObject({
        windowName: 'Gemini 4 Argon (Weekly)', quotaBucketType: 'LONG_TERM', resetTime: new Date(reset(2)),
    });
});

test('只有明确的 Argon 周配额桶会产生周配额行', () => {
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [
        standardGeminiWeekly,
        { ...argonWeekly, bucketId: 'gemini-argon-5h', resetTime: reset(72) },
        { ...argonWeekly, remainingFraction: undefined },
    ] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({ ...response, quota_summary: quotaSummary });
    expect(result.groups?.flatMap(group => group.quotaWindows ?? []).map(window => window.windowName)).not.toContain('Gemini 4 Argon (Weekly)');
    expect(result.groups?.[0].quotaWindows?.map(window => window.windowId)).toEqual(['gemini-weekly']);
});

test('Argon 组同时展示 5 小时限制与周限制', () => {
    const argon5h = { bucketId: 'gemini-argon-5h', displayName: 'Gemini 4 Argon 5h Limit', remainingFraction: 0.42, resetTime: reset(3) };
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [standardGeminiWeekly, argon5h, argonWeekly] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, models: { old: response.models.old, added: response.models.added }, quota_summary: quotaSummary,
    });
    const argonGroup = result.groups?.find(group => group.groupId === 'official:gemini-4-argon');
    expect(argonGroup).toBeDefined();
    const windowIds = argonGroup?.quotaWindows?.map(window => window.windowId) ?? [];
    expect(windowIds).toContain('gemini-argon-wtu-weekly');
    expect(windowIds).toContain('gemini-argon-5h');
    expect(argonGroup?.quotaWindows).toHaveLength(2);
    // 组百分比取所有窗口中最低的
    expect(argonGroup?.remainingPercentage).toBeCloseTo(42, 5);
    // 窗口类型标注正确
    const byId = new Map((argonGroup?.quotaWindows ?? []).map(window => [window.windowId, window]));
    expect(byId.get('gemini-argon-wtu-weekly')?.quotaBucketType).toBe('LONG_TERM');
    expect(byId.get('gemini-argon-5h')?.quotaBucketType).toBe('SHORT_TERM');
});

test('只有 5 小时限制（无周桶）时 Argon 组仍然展示', () => {
    const argon5h = { bucketId: 'gemini-argon-5h', displayName: 'Gemini 4 Argon 5h Limit', remainingFraction: 0.42, resetTime: reset(3) };
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [standardGeminiWeekly, argon5h] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, models: { old: response.models.old, added: response.models.added }, quota_summary: quotaSummary,
    });
    const argonGroup = result.groups?.find(group => group.groupId === 'official:gemini-4-argon');
    expect(argonGroup?.quotaWindows?.map(window => window.windowId)).toEqual(['gemini-argon-5h']);
});

test('周桶用 remainingPercent(0-100) 形式也能解析（不再被丢弃）', () => {
    const weeklyByPercent = { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Weekly', remainingPercent: 88, resetTime: reset(2) };
    const argon5h = { bucketId: 'gemini-argon-5h', remainingFraction: 0.42, resetTime: reset(3) };
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [argon5h, weeklyByPercent] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, models: { old: response.models.old, added: response.models.added }, quota_summary: quotaSummary,
    });
    const argonGroup = result.groups?.find(group => group.groupId === 'official:gemini-4-argon');
    const weekly = argonGroup?.quotaWindows?.find(window => window.windowId === 'gemini-argon-wtu-weekly');
    expect(weekly?.remainingPercentage).toBeCloseTo(88, 5);
    expect(weekly?.quotaBucketType).toBe('LONG_TERM');
});

test('周桶只有已用比例（usedFraction）时取补解析', () => {
    const weeklyByUsed = { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Weekly', usedFraction: 0.09, resetTime: reset(2) };
    const argon5h = { bucketId: 'gemini-argon-5h', remainingFraction: 0.42, resetTime: reset(3) };
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [argon5h, weeklyByUsed] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, models: { old: response.models.old, added: response.models.added }, quota_summary: quotaSummary,
    });
    const argonGroup = result.groups?.find(group => group.groupId === 'official:gemini-4-argon');
    const weekly = argonGroup?.quotaWindows?.find(window => window.windowId === 'gemini-argon-wtu-weekly');
    expect(weekly?.remainingPercentage).toBeCloseTo(91, 5);
});

test('自定义分组继承成员的官方配额窗口（5h + 周）', () => {
    const argon5h = { bucketId: 'gemini-argon-5h', displayName: 'Gemini 4 Argon 5h', remainingFraction: 0.42, resetTime: reset(3) };
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [standardGeminiWeekly, argon5h, argonWeekly] }] };
    // 两个不同池的模型（gemini-pro 5h 池、gemini-argon 周池）放进同一个用户组
    jest.mocked(configService.getConfig).mockReturnValue({
        visibleModels: [],
        groupingEnabled: true,
        groupMappings: { 'gemini-pro': 'g1', 'gemini-argon': 'g1' },
        groupingCustomNames: { 'gemini-pro': 'My Group' },
        pinnedModels: [],
        pinnedGroups: [],
    } as unknown as ReturnType<typeof configService.getConfig>);

    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, quota_summary: quotaSummary,
    });

    const customGroup = result.groups?.find(group => group.groupId.startsWith('custom:'));
    expect(customGroup).toBeDefined();
    expect(customGroup?.groupName).toBe('My Group');
    expect(customGroup?.models.map(model => model.modelId).sort()).toEqual(['gemini-argon', 'gemini-pro']);

    // 关键：用户组必须带窗口明细（否则卡片/状态栏只剩单窗口，周限制不可见）
    const windowIds = customGroup?.quotaWindows?.map(window => window.windowId) ?? [];
    expect(windowIds).toContain('gemini-weekly');
    expect(windowIds).toContain('gemini-argon-wtu-weekly');
    expect(windowIds).toContain('gemini-argon-5h');

    // 官方组中被接管的模型不再重复展示
    const remainingOfficialModels = result.groups
        ?.filter(group => !group.groupId.startsWith('custom:'))
        .flatMap(group => group.models.map(model => model.modelId)) ?? [];
    expect(remainingOfficialModels).not.toContain('gemini-argon');
    expect(remainingOfficialModels).not.toContain('gemini-pro');
});

test('跨池同名周窗口不互相吞并（远程 fallback id 碰撞场景）', () => {
    // 复现：两个官方组的周桶都没有自定义 id → windowId 都回退为 '组名-1' 同名，
    // Gemini 池周 30% 与 Argon 池周 6% 必须各自保留
    const geminiWeeklyNoId = { displayName: 'Weekly', remainingFraction: 0.30, resetTime: reset(50) };
    const argonWeeklyNoId = { displayName: 'Weekly', remainingFraction: 0.06, resetTime: reset(2) };
    const argon5h = { bucketId: 'gemini-argon-5h', remainingFraction: 1.0, resetTime: reset(5) };
    const quotaSummary = { groups: [
        { name: 'Gemini Models', buckets: [geminiWeeklyNoId] },
        { name: 'Gemini 4 Argon', buckets: [argon5h, argonWeeklyNoId] },
    ] };
    jest.mocked(configService.getConfig).mockReturnValue({
        visibleModels: [],
        groupingEnabled: true,
        groupMappings: { 'gemini-pro': 'g1', 'gemini-argon': 'g1' },
        groupingCustomNames: {},
        pinnedModels: [],
        pinnedGroups: [],
    } as unknown as ReturnType<typeof configService.getConfig>);

    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse({
        ...response, quota_summary: quotaSummary,
    });

    const customGroup = result.groups?.find(group => group.groupId.startsWith('custom:'));
    const weeklyWindows = (customGroup?.quotaWindows ?? []).filter(window =>
        /week/i.test(window.windowName));
    // 两条周窗口都要在：30%（Gemini 池）与 6%（Argon 池）
    const pcts = weeklyWindows.map(window => Math.round(window.remainingPercentage)).sort((a, b) => a - b);
    expect(pcts).toEqual([6, 30]);
    // 同名窗口加官方组显示名前缀区分（Argon 池的 6% 行应带组名前缀）
    const names = weeklyWindows.map(window => window.windowName);
    expect(names.some(name => name === 'Gemini 4 Argon · Weekly')).toBe(true);
    expect(names.some(name => name === 'Weekly')).toBe(true);
});

test('账号总览读插件缓存时，用同账号桌面端周配额补齐 Argon 并保留常规 Gemini', async () => {
    const email = 'a@example.test';
    const desktopSummary = { groups: [{ name: 'Gemini 4 Argon', buckets: [argonWeekly] }] };
    jest.mocked(readDesktopQuotaApiCache).mockResolvedValueOnce(quotaCache(email, { quota_summary: desktopSummary }));
    const cached = quotaCache(email, { ...response, quota_summary: { groups: [{ name: 'Gemini Models', buckets: [standardGeminiWeekly] }] } });
    const result = await new ReactorCore().buildCachedAuthorizedSnapshot(cached, email, null);
    expect(result.groups?.map(group => group.remainingPercentage)).toEqual([0, 91]);
});

test.each([
    ['a@example.test', reset(2), 91],
    ['b@example.test', reset(2), undefined],
    ['a@example.test', reset(-1), undefined],
])('本地模式只使用当前账号尚未重置的 Argon 缓存：%s %s', async (cacheEmail, resetTime, expected) => {
    const email = 'a@example.test';
    const reactor = new ReactorCore();
    const transmit = jest.spyOn(reactor as unknown as { transmit: () => Promise<unknown> }, 'transmit');
    reactor.engage(1234, 'test-token');
    transmit.mockResolvedValueOnce({ userStatus: { email } });
    jest.mocked(readDesktopQuotaApiCache).mockResolvedValueOnce(quotaCache(cacheEmail, {
        quota_summary: { groups: [{ buckets: [{ ...argonWeekly, resetTime }] }] },
    }));
    const result = await reactor.fetchMatchingLocalTelemetry(email);
    expect(result?.groups?.[0]?.remainingPercentage).toBe(expected);
});

test('排序表之外的新模型可见，内部模型不可见，配额与重置时间始终来自同一窗口', () => {
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse(response);
    expect(result.models.map(model => model.modelId)).toEqual(['gemini-pro', 'gemini-argon']);
    expect(result.groups?.[0].remainingPercentage).toBe(10);
    expect(result.groups?.[0].resetTime.toISOString()).toBe(reset(5));
});

test('官方周和五小时窗口不被本地补充模型或旧分组设置覆盖', () => {
    const quotaSummary = { groups: [{ name: 'Gemini Models', buckets: [
        { quotaBucketType: 'LONG_TERM', quotaInfo: { remainingFraction: 0.4, resetTime: reset(120) } },
        { quotaBucketType: 'SHORT_TERM', quotaInfo: { remainingFraction: 0.8, resetTime: reset(5) } },
    ] }] };
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse(
        { ...response, quota_summary: quotaSummary }, undefined, 'a@example.test', localSnapshot('a@example.test'),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups?.[0].quotaWindows?.map(window => window.remainingPercentage)).toEqual([40, 80]);
    expect(result.models.map(model => model.modelId)).toContain('local-only');
});

test.each([undefined, 'b@example.test', 'N/A'])('本地身份 %s 不会补充账号 A 的模型', email => {
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse(response, undefined, 'a@example.test', localSnapshot(email));
    expect(result.models.map(model => model.modelId)).not.toContain('local-only');
});

test('失败的本地请求不会重用上一次成功的本地配额', async () => {
    const reactor = new ReactorCore();
    const transmit = jest.spyOn(reactor as unknown as { transmit: () => Promise<unknown> }, 'transmit');
    reactor.engage(1234, 'test-token');
    transmit.mockResolvedValueOnce({ userStatus: { email: 'a@example.test', cascadeModelConfigData: { clientModelConfigs: [] } } });
    expect(await reactor.fetchMatchingLocalTelemetry('a@example.test')).not.toBeNull();
    transmit.mockRejectedValueOnce(new Error('process stopped'));
    expect(await reactor.fetchMatchingLocalTelemetry('a@example.test')).toBeNull();
});

test('本地快照合并共享配额的模型变体，保留不同重置时间和完整模型清单', async () => {
    const reactor = new ReactorCore();
    const transmit = jest.spyOn(reactor as unknown as { transmit: () => Promise<unknown> }, 'transmit');
    reactor.engage(1234, 'test-token');
    transmit.mockResolvedValueOnce({ userStatus: {
        email: 'a@example.test',
        cascadeModelConfigData: { clientModelConfigs: [
            { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'argon-high' }, quotaInfo: { remainingFraction: 0.5, resetTime: reset(1) } },
            { label: 'Gemini 4 Argon (Low)', modelOrAlias: { model: 'argon-low' }, quotaInfo: { remainingFraction: 0.5, resetTime: reset(1) } },
            { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'flash-high' }, quotaInfo: { remainingFraction: 0.5, resetTime: reset(1) } },
            { label: 'Gemini 3.8 Flash (Low)', modelOrAlias: { model: 'flash-low' }, quotaInfo: { remainingFraction: 0.5, resetTime: reset(2) } },
        ] },
    } });
    const snapshot = await reactor.fetchMatchingLocalTelemetry('a@example.test');
    expect(snapshot?.models.map(model => model.label)).toEqual([
        'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)', 'Gemini 4 Argon',
    ]);
    expect(snapshot?.allModels).toHaveLength(4);
    expect(snapshot?.userInfo?.availablePromptCredits).toBeUndefined();
});

test('授权缓存只为同一账号提供已知积分', () => {
    const reactor = new ReactorCore();
    reactor['lastAuthorizedCredits'] = { account: 'a@example.test', amount: 500 };
    expect(reactor.buildAuthorizedSnapshotFromResponse(response, undefined, 'A@example.test').availableAICredits).toBe(500);
    expect(reactor.buildAuthorizedSnapshotFromResponse(response, undefined, 'b@example.test').availableAICredits).toBeUndefined();
});

test('已验证的本地账号只补充新模型，不覆盖云端配额或带入黑名单', () => {
    const local = localSnapshot(' A@EXAMPLE.TEST ');
    local.models.push({ ...local.models[0], modelId: 'gemini-pro' });
    local.models.push({ ...local.models[0], modelId: 'MODEL_PLACEHOLDER_M19' });
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse(response, undefined, 'a@example.test', local);
    expect(result.models.map(model => model.modelId)).toEqual(['gemini-pro', 'gemini-argon', 'local-only']);
    expect(result.models[0].remainingPercentage).toBe(90);
});

test('新增模型纳入自定义可见列表，保留已有选择', () => {
    jest.mocked(configService.getStateValue).mockReturnValueOnce(['gemini-pro']);
    jest.mocked(configService.getConfig).mockReturnValue({ visibleModels: ['gemini-pro'] } as ReturnType<typeof configService.getConfig>);
    const result = new ReactorCore().buildAuthorizedSnapshotFromResponse(response);
    expect(result.models.map(model => model.modelId)).toEqual(['gemini-pro', 'gemini-argon']);
    expect(configService.updateVisibleModels).toHaveBeenCalledWith(['gemini-pro', 'gemini-argon']);
});
