import { promises as fs } from 'fs';
import { recordQuotaHistory, getQuotaHistory, QuotaHistoryRecord } from './quota_history';
import { writePrivateFileAtomic } from '../shared/secure_fs';
import { QuotaSnapshot } from '../shared/types';

jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
jest.mock('../shared/secure_fs', () => ({ writePrivateFileAtomic: jest.fn() }));
jest.mock('../shared/log_service', () => ({ logger: { debug: jest.fn() } }));

const start = Date.UTC(2026, 10, 3, 12);
const minute = 60000;
let stored: QuotaHistoryRecord | null;

function snapshot(percent: number, resetMinutes = 300): QuotaSnapshot {
    return {
        timestamp: new Date(), isConnected: true,
        models: [{ modelId: 'model-a', label: 'Model A', remainingPercentage: percent, resetTime: new Date(start + resetMinutes * minute), isExhausted: false, timeUntilReset: 0, timeUntilResetFormatted: '', resetTimeDisplay: '' }],
    };
}
async function record(minutes: number, percent: number, resetMinutes?: number) {
    jest.setSystemTime(start + minutes * minute);
    await recordQuotaHistory('a@example.test', snapshot(percent, resetMinutes));
}

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(start);
    stored = null;
    jest.mocked(fs.readFile).mockImplementation(async () => {
        if (!stored) {
            throw new Error('missing history');
        }
        return JSON.stringify(stored);
    });
    jest.mocked(writePrivateFileAtomic).mockImplementation(async (_file, content) => {
        stored = JSON.parse(content) as QuotaHistoryRecord;
    });
});
afterEach(() => jest.useRealTimers());

test('静止配额每十分钟保留一个样本，刷新仍记录最新趋势', async () => {
    await record(0, 70);
    await record(30, 60);
    await record(60, 50);
    expect((await getQuotaHistory('a@example.test', 1))?.prediction).not.toBeNull();
    await record(65, 50);
    expect((await getQuotaHistory('a@example.test', 1))?.points).toHaveLength(3);
    await record(70, 50);
    const history = await getQuotaHistory('a@example.test', 1);
    expect(history?.points).toHaveLength(4);
    expect(history?.points[3].timestamp).toBe(start + 70 * minute);
});

test('停止采样后不对旧数据展示预测', async () => {
    await record(0, 70);
    await record(30, 60);
    await record(60, 50);
    jest.setSystemTime(start + 120 * minute);
    expect((await getQuotaHistory('a@example.test', 1))?.prediction).toBeNull();
});

test('经过重置后百分比恰好相同也必须开启新周期', async () => {
    await record(0, 70, 90);
    await record(30, 60, 90);
    await record(60, 50, 90);
    await record(91, 50, 390);
    const history = await getQuotaHistory('a@example.test', 1);
    expect(history?.points[3].isReset).toBe(true);
    expect(history?.prediction).toBeNull();
});

test('新增 Argon 周配额有独立历史，普通 Gemini 周配额和旧模型历史仍可读取', async () => {
    const email = 'a@example.test';
    await record(0, 65);
    const next = snapshot(80);
    const { resetTime, isExhausted, timeUntilReset, timeUntilResetFormatted, resetTimeDisplay } = next.models[0];
    const timing = { resetTime, isExhausted, timeUntilResetFormatted, resetTimeDisplay };
    const windows = [
        { groupId: 'official:gemini-models', groupName: 'Gemini Models', windowId: 'gemini-weekly', windowName: 'Weekly Limit', remainingPercentage: 80 },
        { groupId: 'official:gemini-4-argon', groupName: 'Gemini 4 Argon', windowId: 'gemini-argon-wtu-weekly', windowName: 'Gemini 4 Argon (Weekly)', remainingPercentage: 45 },
    ];
    next.groups = windows.map(({ groupId, groupName, windowId, windowName, remainingPercentage }) => ({
        ...timing,
        groupId,
        groupName,
        models: [],
        remainingPercentage,
        quotaWindows: [{ ...timing, timeUntilReset, windowId, windowName, remainingPercentage }],
    }));
    await recordQuotaHistory(email, next);

    const argon = await getQuotaHistory(email, 1, 'official:gemini-4-argon:gemini-argon-wtu-weekly');
    const gemini = await getQuotaHistory(email, 1, 'official:gemini-models:gemini-weekly');
    const legacy = await getQuotaHistory(email, 1, 'model-a');
    expect(argon?.points.map(point => point.remainingPercentage)).toEqual([45]);
    expect(gemini?.points.map(point => point.remainingPercentage)).toEqual([80]);
    expect(legacy?.points.map(point => point.remainingPercentage)).toEqual([65]);
});
