import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { writePrivateFileAtomic } from '../shared/secure_fs';

export type QuotaCacheSource = 'authorized' | 'local';

export interface QuotaCacheModel {
    id: string;
    displayName?: string;
    remainingPercentage?: number;
    remainingFraction?: number;
    resetTime?: string;
    isRecommended?: boolean;
    tagTitle?: string;
    supportsImages?: boolean;
    supportedMimeTypes?: Record<string, boolean>;
}

export interface QuotaCacheRecord {
    version: 1;
    source: QuotaCacheSource;
    email?: string | null;
    updatedAt: number;
    subscriptionTier?: string | null;
    isForbidden?: boolean;
    models: QuotaCacheModel[];
}

const CACHE_ROOT = path.join(os.homedir(), '.antigravity_cockpit', 'cache', 'quota_v2');

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function hashEmail(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function getCacheFilePath(source: QuotaCacheSource, email: string): string {
    const filename = `${hashEmail(email)}.json`;
    return path.join(CACHE_ROOT, source, filename);
}

export async function readQuotaCache(
    source: QuotaCacheSource,
    email: string,
): Promise<QuotaCacheRecord | null> {
    try {
        const filePath = getCacheFilePath(source, email);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as QuotaCacheRecord;
        if (!parsed || parsed.version !== 1 || parsed.source !== source) {
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

export async function writeQuotaCache(record: QuotaCacheRecord): Promise<void> {
    if (!record.email) {
        return;
    }
    const filePath = getCacheFilePath(record.source, record.email);
    const content = JSON.stringify(record, null, 2);
    await writePrivateFileAtomic(filePath, content);
}

/** 缓存过期时间（毫秒）：60秒 */
export const CACHE_TTL_MS = 60 * 1000;

/**
 * 检查缓存是否有效（未过期）
 * @param record 缓存记录
 * @param ttlMs 过期时间（毫秒），默认 CACHE_TTL_MS
 * @returns true 表示缓存有效，false 表示已过期或无效
 */
export function isCacheValid(record: QuotaCacheRecord | null, ttlMs: number = CACHE_TTL_MS): boolean {
    if (!record || !record.models?.length) {
        return false;
    }
    const now = Date.now();
    const age = now - record.updatedAt;
    return age < ttlMs;
}

/**
 * 获取缓存年龄（毫秒）
 * @param record 缓存记录
 * @returns 缓存年龄，如果无效返回 Infinity
 */
export function getCacheAge(record: QuotaCacheRecord | null): number {
    if (!record || !record.updatedAt) {
        return Infinity;
    }
    return Date.now() - record.updatedAt;
}
