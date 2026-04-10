/**
 * Cockpit Tools 本地文件读取服务
 * 直接读取 ~/.antigravity_cockpit/ 下的 JSON 文件获取数据
 * 不依赖 WebSocket 连接
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/log_service';
import { getCockpitToolsSharedDir } from '../shared/antigravity_paths';

const ACCOUNTS_INDEX = 'accounts.json';

/** accounts.json 中的账号条目 */
interface AccountEntry {
    id: string;
    email: string;
    name: string | null;
    created_at: number;
    last_used: number;
}

/** accounts.json 的完整结构 */
interface AccountsIndex {
    version: string;
    accounts: AccountEntry[];
    current_account_id: string | null;
}

class CockpitToolsLocal {
    /**
     * 读取 accounts.json 索引文件
     */
    private readAccountsIndex(): AccountsIndex | null {
        const filePath = path.join(getCockpitToolsSharedDir(), ACCOUNTS_INDEX);
        try {
            if (!fs.existsSync(filePath)) {
                logger.warn('[CockpitToolsLocal] accounts.json 不存在');
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as AccountsIndex;
        } catch (err) {
            logger.error(`[CockpitToolsLocal] 读取 accounts.json 失败: ${err}`);
            return null;
        }
    }

    /**
     * 通过 email 获取账号 ID（不依赖 WebSocket）
     */
    getAccountIdByEmail(email: string): string | null {
        const index = this.readAccountsIndex();
        if (!index) { return null; }

        const account = index.accounts.find(
            a => a.email.toLowerCase() === email.toLowerCase(),
        );
        return account?.id ?? null;
    }

    /**
     * 获取完整账号列表
     */
    getAccountsList(): AccountEntry[] {
        const index = this.readAccountsIndex();
        return index?.accounts ?? [];
    }

    /**
     * 获取当前激活账号 ID
     */
    getCurrentAccountId(): string | null {
        const index = this.readAccountsIndex();
        return index?.current_account_id ?? null;
    }

    /**
     * 获取当前激活账号 email
     */
    getCurrentAccountEmail(): string | null {
        const index = this.readAccountsIndex();
        if (!index?.current_account_id) { return null; }
        const account = index.accounts.find(a => a.id === index.current_account_id);
        return account?.email ?? null;
    }
}

export const cockpitToolsLocal = new CockpitToolsLocal();
