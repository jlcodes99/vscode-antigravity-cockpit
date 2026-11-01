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
import { logger } from './log_service';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** 递归创建目录并收紧权限为 700（已存在则只修正目录本身权限，不递归改父目录）。 */
export async function ensurePrivateDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
    try {
        await fs.chmod(dirPath, PRIVATE_DIR_MODE);
    } catch (error) {
        logger.debug(`[SecureFs] chmod dir failed: ${dirPath} ${String(error)}`);
    }
}

/**
 * 原子写入文件并强制 600 权限。
 * 先写 `${file}.tmp`（创建即 600），再 rename 覆盖目标。
 */
export async function writePrivateFileAtomic(filePath: string, content: string): Promise<void> {
    await ensurePrivateDir(path.dirname(filePath));
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    try {
        await fs.chmod(tempPath, PRIVATE_FILE_MODE);
    } catch {
        // mode 选项在部分平台对已存在的 temp 文件不生效，chmod 兜底
    }
    await fs.rename(tempPath, filePath);
}

/** 同步版本：用于无法 await 的写入点（如配置 merge）。 */
export function writePrivateFileSync(filePath: string, content: string): void {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    fsSync.writeFileSync(filePath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    try {
        fsSync.chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch {
        // 权限收紧失败不应阻断主流程
    }
}
