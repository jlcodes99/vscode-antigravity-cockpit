import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { writePrivateFileAtomic } from '../shared/secure_fs';
import { getCockpitToolsSharedDir } from '../shared/antigravity_paths';

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

type DesktopQuotaApiCacheRecord = Omit<QuotaApiCacheRecord, 'version'> & { version: 1 | 2 };

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

function getDesktopCacheFilePath(source: QuotaApiCacheSource, email: string): string {
    const filename = `${hashKey(email)}.json`;
    return path.join(getCockpitToolsSharedDir(), 'cache', 'quota_api_v1_desktop', source, filename);
}

export async function readQuotaApiCache(
    source: QuotaApiCacheSource,
    email: string,
): Promise<QuotaApiCacheRecord | null> {
    try {
        const filePath = getCacheFilePath(source, email);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as QuotaApiCacheRecord;
        if (!parsed || parsed.version !== 1 || parsed.source !== source || typeof parsed.email !== 'string' || normalizeEmail(parsed.email) !== normalizeEmail(email)) {
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

export async function readDesktopQuotaApiCache(
    source: QuotaApiCacheSource,
    email: string,
): Promise<DesktopQuotaApiCacheRecord | null> {
    try {
        const filePath = getDesktopCacheFilePath(source, email);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as DesktopQuotaApiCacheRecord;
        if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || parsed.source !== source
            || typeof parsed.email !== 'string' || normalizeEmail(parsed.email) !== normalizeEmail(email)) {
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

export async function writeQuotaApiCache(record: QuotaApiCacheRecord): Promise<void> {
    await writePrivateFileAtomic(getCacheFilePath(record.source, record.email), JSON.stringify(record, null, 2));
}

/** 缓存过期时间（毫秒）：60秒 */
export const CACHE_TTL_MS = 60 * 1000;

export function isApiCacheValid(record: QuotaApiCacheRecord | null, ttlMs: number = CACHE_TTL_MS): boolean {
    if (!record || !record.updatedAt) {
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
