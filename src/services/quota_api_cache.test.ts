import { promises as fs } from 'fs';
import { readDesktopQuotaApiCache } from './quota_api_cache';

afterEach(() => jest.restoreAllMocks());

test('读取桌面端 v2 配额缓存，并核对账号归属', async () => {
    const record = {
        version: 2, source: 'authorized', customSource: 'desktop', email: 'example@test.invalid', updatedAt: 1,
        payload: { quota_summary: { groups: [{ buckets: [{ bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 1 }] }] } },
    };
    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(record));
    await expect(readDesktopQuotaApiCache('authorized', 'EXAMPLE@test.invalid')).resolves.toEqual(record);
    await expect(readDesktopQuotaApiCache('authorized', 'other@test.invalid')).resolves.toBeNull();
});
