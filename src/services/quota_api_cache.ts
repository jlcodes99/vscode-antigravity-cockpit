import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

export type QuotaApiCacheSource = 'authorized';

export interface QuotaApiCacheRecord {
    version: 1;
    source: QuotaApiCacheSource;
    customSource: 'plugin' | 'desktop';
    email: string;
    projectId?: string | null;
    updatedAt: number;
    payload: unknown;
}

// 插件端在同一根目录下使用独立子目录，避免与桌面端共享/覆盖
const CACHE_ROOT = path.join(os.homedir(), '.antigravity_cockpit', 'cache', 'quota_api_v1_plugin');

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function hashKey(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function getCacheFilePath(source: QuotaApiCacheSource, email: string): string {
    const filename = `${hashKey(email)}.json`;
    return path.join(CACHE_ROOT, source, filename);
}

async function ensureCacheDir(source: QuotaApiCacheSource): Promise<void> {
    const dir = path.join(CACHE_ROOT, source);
    await fs.mkdir(dir, { recursive: true });
}

export async function readQuotaApiCache(
    source: QuotaApiCacheSource,
    email: string,
): Promise<QuotaApiCacheRecord | null> {
    try {
        const filePath = getCacheFilePath(source, email);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as QuotaApiCacheRecord;
        if (!parsed || parsed.version !== 1 || parsed.source !== source) {
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

export async function writeQuotaApiCache(record: QuotaApiCacheRecord): Promise<void> {
    await ensureCacheDir(record.source);
    const filePath = getCacheFilePath(record.source, record.email);
    const tempPath = `${filePath}.tmp`;
    const content = JSON.stringify(record, null, 2);
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
}

/** 缓存过期时间（毫秒）：60秒 */
export const CACHE_TTL_MS = 60 * 1000;

export function isApiCacheValid(record: QuotaApiCacheRecord | null, ttlMs: number = CACHE_TTL_MS): boolean {
    if (!record || !record.updatedAt) {
        return false;
    }
    // 不含限额汇总（周限额）的缓存（旧版本或其他窗口写入）视为无效，强制重新请求
    const payload = record.payload as { quota_summary?: { groups?: unknown[] } } | null | undefined;
    if (!payload?.quota_summary?.groups?.length) {
        return false;
    }
    const age = Date.now() - record.updatedAt;
    return age < ttlMs;
}

export function getApiCacheAge(record: QuotaApiCacheRecord | null): number {
    if (!record || !record.updatedAt) {
        return Infinity;
    }
    return Date.now() - record.updatedAt;
}
