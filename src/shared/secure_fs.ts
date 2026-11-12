/**
 * 安全文件写入工具。
 *
 * 共享目录 ~/.antigravity_cockpit 下的缓存/设置文件可能包含邮箱等个人数据，
 * 在多用户机器上不能依赖默认 umask（通常产生 644）。统一强制：
 * - 目录 0o700（仅属主可进入）
 * - 文件 0o600（仅属主可读写）
 * 并保持 temp + rename 的原子写模式。
 */

import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** 递归创建目录并收紧权限为 700（已存在则只修正目录本身权限，不递归改父目录）。 */
export async function ensurePrivateDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (process.platform !== 'win32') {
        await fs.chmod(dirPath, PRIVATE_DIR_MODE);
    }
}

/**
 * 原子写入文件并强制 600 权限。
 * 每次使用独立临时文件（创建即 600），再 rename 覆盖目标。
 */
export async function writePrivateFileAtomic(filePath: string, content: string): Promise<void> {
    await ensurePrivateDir(path.dirname(filePath));
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
        await fs.rename(tempPath, filePath);
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

/** 同步版本：用于无法 await 的写入点（如配置 merge）。 */
export function writePrivateFileSync(filePath: string, content: string): void {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    if (process.platform !== 'win32') {
        fsSync.chmodSync(path.dirname(filePath), PRIVATE_DIR_MODE);
    }
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        fsSync.writeFileSync(tempPath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
        fsSync.renameSync(tempPath, filePath);
    } finally {
        fsSync.rmSync(tempPath, { force: true });
    }
}
