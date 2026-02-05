import * as path from 'path';
import * as fs from 'fs';
// 使用 sql.js 的 wasm 版本（需要 .wasm 文件）
import initSqlJs, { Database } from 'sql.js/dist/sql-wasm.js';
import { credentialStorage } from './credential_storage';
import { oauthService } from './oauth_service';
import { OAuthCredential } from './types';
import { logger } from '../shared/log_service';
import { getAntigravityStateDbPath, getAntigravityUserDataDir } from '../shared/antigravity_paths';

const LEGACY_STATE_KEY = 'jetskiStateSync.agentManagerInitState';
const UNIFIED_STATE_KEY = 'antigravityUnifiedStateSync.oauthToken';

// sql.js 初始化缓存
let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

async function getSqlJs(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
    if (!sqlJsPromise) {
        sqlJsPromise = initSqlJs({
            locateFile: (file: string) => path.join(__dirname, file),
        });
    }
    return sqlJsPromise;
}

interface LocalTokenInfo {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expirySeconds?: number;
}

interface PendingLocalCredential {
    credential: OAuthCredential;
    createdAt: number;
}

const PENDING_CREDENTIAL_TTL_MS = 2 * 60 * 1000;
let pendingLocalCredential: PendingLocalCredential | null = null;

// 注意：state.vscdb 路径统一由 shared/antigravity_paths 提供，避免多处维护。

async function readStateValueByKey(dbPath: string, key: string): Promise<string> {
    // 检查数据库文件是否存在
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database file not found: ${dbPath}`);
    }

    const SQL = await getSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    let db: Database | null = null;

    try {
        db = new SQL.Database(fileBuffer);
        const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
        stmt.bind([key]);

        if (stmt.step()) {
            const row = stmt.get();
            stmt.free();
            if (row && row[0]) {
                const value = String(row[0]).trim();
                if (value.length > 0) {
                    return value;
                }
            }
        } else {
            stmt.free();
        }

        throw new Error('No state value found');
    } finally {
        if (db) {
            db.close();
        }
    }
}

function readVarint(data: Buffer, offset: number): [number, number] {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < data.length) {
        const byte = data[pos];
        result += (byte & 0x7f) * Math.pow(2, shift);
        pos += 1;
        if ((byte & 0x80) === 0) {
            return [result, pos];
        }
        shift += 7;
    }
    throw new Error('Incomplete varint');
}

function skipField(data: Buffer, offset: number, wireType: number): number {
    if (wireType === 0) {
        const [, newOffset] = readVarint(data, offset);
        return newOffset;
    }
    if (wireType === 1) {
        return offset + 8;
    }
    if (wireType === 2) {
        const [length, contentOffset] = readVarint(data, offset);
        return contentOffset + length;
    }
    if (wireType === 5) {
        return offset + 4;
    }
    throw new Error(`Unknown wire type: ${wireType}`);
}

function findField(data: Buffer, targetField: number): Buffer | undefined {
    let offset = 0;
    while (offset < data.length) {
        let tag = 0;
        let newOffset = 0;
        try {
            [tag, newOffset] = readVarint(data, offset);
        } catch {
            break;
        }
        const wireType = tag & 7;
        const fieldNum = tag >> 3;
        if (fieldNum === targetField && wireType === 2) {
            const [length, contentOffset] = readVarint(data, newOffset);
            return data.subarray(contentOffset, contentOffset + length);
        }
        offset = skipField(data, newOffset, wireType);
    }
    return undefined;
}

function parseTimestamp(data: Buffer): number | undefined {
    let offset = 0;
    while (offset < data.length) {
        const [tag, newOffset] = readVarint(data, offset);
        const wireType = tag & 7;
        const fieldNum = tag >> 3;
        offset = newOffset;
        if (fieldNum === 1 && wireType === 0) {
            const [seconds] = readVarint(data, offset);
            return seconds;
        }
        offset = skipField(data, offset, wireType);
    }
    return undefined;
}

function parseOAuthTokenInfo(data: Buffer): LocalTokenInfo {
    let offset = 0;
    const info: LocalTokenInfo = {};

    while (offset < data.length) {
        const [tag, newOffset] = readVarint(data, offset);
        const wireType = tag & 7;
        const fieldNum = tag >> 3;
        offset = newOffset;

        if (wireType === 2) {
            const [length, contentOffset] = readVarint(data, offset);
            const value = data.subarray(contentOffset, contentOffset + length);
            offset = contentOffset + length;

            if (fieldNum === 1) {
                info.accessToken = value.toString();
            } else if (fieldNum === 2) {
                info.tokenType = value.toString();
            } else if (fieldNum === 3) {
                info.refreshToken = value.toString();
            } else if (fieldNum === 4) {
                info.expirySeconds = parseTimestamp(value);
            }
            continue;
        }
        offset = skipField(data, offset, wireType);
    }

    return info;
}

function parseUnifiedOAuthTokenInfo(stateValue: string): LocalTokenInfo {
    const outerRaw = Buffer.from(stateValue.trim(), 'base64');
    const inner = findField(outerRaw, 1);
    if (!inner) {
        throw new Error('Unified oauth outer field not found');
    }

    const sentinel = findField(inner, 1)?.toString();
    if (sentinel !== 'oauthTokenInfoSentinelKey') {
        throw new Error('Unified oauth sentinel mismatch');
    }

    const inner2 = findField(inner, 2);
    if (!inner2) {
        throw new Error('Unified oauth inner field not found');
    }

    const oauthInfoB64 = findField(inner2, 1)?.toString();
    if (!oauthInfoB64) {
        throw new Error('Unified oauth info not found');
    }

    const oauthInfoRaw = Buffer.from(oauthInfoB64.trim(), 'base64');
    return parseOAuthTokenInfo(oauthInfoRaw);
}

async function readLocalTokenInfo(): Promise<LocalTokenInfo> {
    const dbPath = getAntigravityStateDbPath();
    logger.info(`[LocalAuth] state.vscdb path: ${dbPath}`);

    // 新格式优先：antigravityUnifiedStateSync.oauthToken
    try {
        const unifiedValue = await readStateValueByKey(dbPath, UNIFIED_STATE_KEY);
        const unifiedInfo = parseUnifiedOAuthTokenInfo(unifiedValue);
        if (unifiedInfo.refreshToken) {
            logger.debug('[LocalAuth] Parsed oauth token from unified state key');
            return unifiedInfo;
        }
        logger.debug('[LocalAuth] Unified state key parsed but refresh_token missing, fallback to legacy key');
    } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.debug(`[LocalAuth] Unified state parse failed, fallback to legacy key: ${err}`);
    }

    // 旧格式兜底：jetskiStateSync.agentManagerInitState -> field 6
    const legacyValue = await readStateValueByKey(dbPath, LEGACY_STATE_KEY);
    const raw = Buffer.from(legacyValue.trim(), 'base64');
    const oauthField = findField(raw, 6);
    if (!oauthField) {
        throw new Error('OAuth field not found in legacy state');
    }
    return parseOAuthTokenInfo(oauthField);
}

async function loadCredentialFromStateDb(): Promise<OAuthCredential | null> {
    const tokenInfo = await readLocalTokenInfo();
    if (!tokenInfo.refreshToken) {
        logger.debug('[LocalAuth] No refresh token found in state.vscdb');
        return null;
    }

    const credential = await oauthService.buildCredentialFromRefreshToken(
        tokenInfo.refreshToken,
        undefined,
    );

    if (!credential.email || !credential.accessToken) {
        logger.debug('[LocalAuth] Failed to build credential: missing email or accessToken');
        return null;
    }

    return credential;
}

export async function previewLocalCredential(
    fallbackEmail?: string,
): Promise<{ email: string; exists: boolean }> {
    const tokenInfo = await readLocalTokenInfo();
    if (!tokenInfo.refreshToken) {
        throw new Error('refresh_token not found');
    }

    logger.info(`[LocalAuthImport] Found local refresh token (len=${tokenInfo.refreshToken.length})`);

    const credential = await oauthService.buildCredentialFromRefreshToken(
        tokenInfo.refreshToken,
        fallbackEmail,
    );

    if (!credential.email) {
        throw new Error('无法确定账号邮箱');
    }

    logger.info(`[LocalAuthImport] resolved account: ${credential.email}`);
    pendingLocalCredential = {
        credential,
        createdAt: Date.now(),
    };

    const exists = await credentialStorage.hasAccount(credential.email);
    return { email: credential.email, exists };
}

export async function commitLocalCredential(
    options: { overwrite?: boolean; fallbackEmail?: string } = {},
): Promise<{ email: string; existed: boolean }> {
    let credential: OAuthCredential | null = null;
    const now = Date.now();
    if (pendingLocalCredential && now - pendingLocalCredential.createdAt <= PENDING_CREDENTIAL_TTL_MS) {
        credential = pendingLocalCredential.credential;
    }
    pendingLocalCredential = null;

    if (!credential) {
        const tokenInfo = await readLocalTokenInfo();
        if (!tokenInfo.refreshToken) {
            throw new Error('refresh_token not found');
        }
        credential = await oauthService.buildCredentialFromRefreshToken(
            tokenInfo.refreshToken,
            options.fallbackEmail,
        );
    }

    if (!credential.email) {
        throw new Error('无法确定账号邮箱');
    }

    const existed = await credentialStorage.hasAccount(credential.email);
    if (existed && !options.overwrite) {
        throw new Error('Account already exists');
    }

    await credentialStorage.saveCredential(credential);
    await credentialStorage.clearAccountInvalid(credential.email);
    await credentialStorage.setActiveAccount(credential.email);

    return { email: credential.email, existed };
}

export async function importLocalCredential(fallbackEmail?: string): Promise<{ email: string }> {
    const result = await commitLocalCredential({ overwrite: true, fallbackEmail });
    return { email: result.email };
}

/**
 * 确保本地 Antigravity 账户已导入到 credentialStorage
 * 用于 local 配额模式下通过远端 API 获取配额数据
 * - 如果 credentialStorage 已有有效凭证，直接返回当前账户邮箱
 * - 如果没有，尝试从 state.vscdb 读取并保存到 credentialStorage
 * @returns 账户邮箱或 null
 */
export async function ensureLocalCredentialImported(
    options: { forceReload?: boolean } = {},
): Promise<{ email: string } | null> {
    if (options.forceReload) {
        logger.info('[LocalAuthDebug] Force reload: skip cached credential');
    }

    const instanceDir = getAntigravityUserDataDir();
    if (!options.forceReload && !instanceDir) {
        const hasValid = await credentialStorage.hasValidCredential();
        if (hasValid) {
            const activeEmail = await credentialStorage.getActiveAccount();
            if (activeEmail) {
                logger.debug(`[LocalAuth] Using existing credential: ${activeEmail}`);
                return { email: activeEmail };
            }
        }
    }

    try {
        const credential = await loadCredentialFromStateDb();
        if (!credential) {
            return null;
        }

        // 保存到 credentialStorage（自动导入）
        await credentialStorage.saveCredential(credential);
        logger.info(`[LocalAuth] resolved account: ${credential.email}`);
        logger.info(`[LocalAuth] Auto-imported credential for ${credential.email}`);
        return { email: credential.email };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.debug(`[LocalAuth] Failed to import local credential: ${err.message}`);
        return null;
    }
}

export async function debugLocalCredentialImport(): Promise<{ email?: string; dbPath: string }> {
    logger.info('[LocalAuthDebug] Starting local credential debug...');
    const dbPath = getAntigravityStateDbPath();
    logger.info(`[LocalAuthDebug] Using state.vscdb: ${dbPath}`);
    logger.info(`[LocalAuthDebug] override user-data-dir: ${getAntigravityUserDataDir() ?? 'null'}`);
    const result = await ensureLocalCredentialImported({ forceReload: true });
    logger.info(`[LocalAuthDebug] Result: ${result?.email ?? 'null'}`);
    return { email: result?.email, dbPath };
}
