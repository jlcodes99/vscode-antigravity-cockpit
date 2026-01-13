import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { credentialStorage } from './credential_storage';
import { oauthService } from './oauth_service';
import { OAuthCredential } from './types';
import { logger } from '../shared/log_service';

const execFileAsync = promisify(execFile);

const STATE_KEY = 'jetskiStateSync.agentManagerInitState';

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

function getAntigravityStateDbPath(): string {
    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(
            homeDir,
            'Library',
            'Application Support',
            'Antigravity',
            'User',
            'globalStorage',
            'state.vscdb',
        );
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}

async function readStateValue(dbPath: string): Promise<string> {
    const { stdout } = await execFileAsync(
        'sqlite3',
        ['-readonly', dbPath, `SELECT value FROM ItemTable WHERE key = '${STATE_KEY}';`],
        { maxBuffer: 10 * 1024 * 1024 },
    );
    const line = stdout
        .split(/\r?\n/)
        .map(value => value.trim())
        .find(value => value.length > 0);
    if (!line) {
        throw new Error('No state value found');
    }
    return line;
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

async function readLocalTokenInfo(): Promise<LocalTokenInfo> {
    const dbPath = getAntigravityStateDbPath();
    const stateValue = await readStateValue(dbPath);
    const raw = Buffer.from(stateValue.trim(), 'base64');
    const oauthField = findField(raw, 6);
    if (!oauthField) {
        throw new Error('OAuth field not found');
    }
    return parseOAuthTokenInfo(oauthField);
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
export async function ensureLocalCredentialImported(): Promise<{ email: string } | null> {
    // 首先检查是否已有有效凭证
    const hasValid = await credentialStorage.hasValidCredential();
    if (hasValid) {
        const activeEmail = await credentialStorage.getActiveAccount();
        if (activeEmail) {
            logger.debug(`[LocalAuth] Using existing credential: ${activeEmail}`);
            return { email: activeEmail };
        }
    }

    // 没有有效凭证，尝试从 state.vscdb 导入
    try {
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

        // 保存到 credentialStorage（自动导入）
        await credentialStorage.saveCredential(credential);
        logger.info(`[LocalAuth] Auto-imported credential for ${credential.email}`);
        return { email: credential.email };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.debug(`[LocalAuth] Failed to import local credential: ${err.message}`);
        return null;
    }
}

