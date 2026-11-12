/**
 * 离线配置同步模块
 * 用于在 WebSocket 离线时，通过共享文件同步配置
 * 
 * 设计说明:
 * - 在线时: 通过 WebSocket 实时同步，不写入共享文件
 * - 离线时: 写入共享文件，等对方启动时读取合并
 * - 启动时: 读取共享文件，与本地配置比较时间戳后合并
 * 
 * 可扩展性:
 * - 目前支持 language 配置
 * - 可扩展支持 theme、accounts 等其他配置
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../shared/log_service';
import { writePrivateFileSync } from '../shared/secure_fs';

/** 共享配置目录 */
const SHARED_DIR = path.join(os.homedir(), '.antigravity_cockpit');

/** 同步配置文件名 */
const SYNC_SETTINGS_FILE = 'sync_settings.json';

/** 配置项类型 */
export type SyncSettingKey = 'language' | 'theme';

/** 单个配置项结构 */
export interface SyncSettingValue {
    value: string;
    updated_at: number;
    updated_by: 'plugin' | 'desktop';
}

/** 同步配置文件结构 */
export interface SyncSettings {
    language?: SyncSettingValue;
    theme?: SyncSettingValue;
    // 可扩展其他配置项
}

/**
 * 获取同步配置文件路径
 */
function getSyncSettingsPath(): string {
    return path.join(SHARED_DIR, SYNC_SETTINGS_FILE);
}

/**
 * 确保共享目录存在
 */
function ensureSharedDir(): void {
    if (!fs.existsSync(SHARED_DIR)) {
        fs.mkdirSync(SHARED_DIR, { recursive: true });
    }
}

/**
 * 读取同步配置文件
 * @returns 同步配置，如果文件不存在或损坏则返回空对象
 */
export function readSyncSettings(): SyncSettings {
    try {
        const filePath = getSyncSettingsPath();
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as SyncSettings;
        }
    } catch (error) {
        logger.warn('[SyncSettings] 读取同步配置失败, 返回空配置:', error);
    }
    return {};
}

/**
 * 写入单个同步配置项
 * 用于离线时保存配置，等对方启动时读取
 * 
 * @param key 配置项键名
 * @param value 配置项值
 */
export function writeSyncSetting(key: SyncSettingKey, value: string): void {
    try {
        ensureSharedDir();
        
        const settings = readSyncSettings();
        settings[key] = {
            value,
            updated_at: Date.now(),
            updated_by: 'plugin',
        };
        
        const filePath = getSyncSettingsPath();
        writePrivateFileSync(filePath, JSON.stringify(settings, null, 2));

        logger.info(`[SyncSettings] 写入离线配置: ${key} = ${value}`);
    } catch (error) {
        logger.error('[SyncSettings] 写入同步配置失败:', error);
    }
}

/**
 * 清除单个同步配置项
 * 用于已同步后清理，避免下次重复同步
 * 
 * @param key 配置项键名
 */
export function clearSyncSetting(key: SyncSettingKey): void {
    try {
        const settings = readSyncSettings();
        if (settings[key]) {
            delete settings[key];
            
            const filePath = getSyncSettingsPath();
            writePrivateFileSync(filePath, JSON.stringify(settings, null, 2));

            logger.info(`[SyncSettings] 清除已同步配置: ${key}`);
        }
    } catch (error) {
        logger.error('[SyncSettings] 清除同步配置失败:', error);
    }
}

/**
 * 获取单个同步配置项
 * 
 * @param key 配置项键名
 * @returns 配置项值，如果不存在则返回 undefined
 */
export function getSyncSetting(key: SyncSettingKey): SyncSettingValue | undefined {
    const settings = readSyncSettings();
    return settings[key];
}

/**
 * 比较并合并配置
 * 返回是否需要更新本地配置
 * 
 * @param key 配置项键名
 * @param localValue 本地当前值
 * @param localUpdatedAt 本地更新时间（如果有的话）
 * @returns 如果需要更新本地，返回新值；否则返回 undefined
 */
export function mergeSettingOnStartup(
    key: SyncSettingKey,
    localValue: string,
    localUpdatedAt?: number,
): string | undefined {
    const syncSetting = getSyncSetting(key);
    
    if (!syncSetting) {
        // 共享文件没有这个配置，不需要更新
        return undefined;
    }
    
    // 如果共享文件的值和本地相同，不需要更新
    if (syncSetting.value === localValue) {
        // 清除共享文件中的配置（已一致）
        clearSyncSetting(key);
        return undefined;
    }
    
    // 如果共享文件更新时间更晚，或者本地没有更新时间记录，使用共享文件的值
    if (!localUpdatedAt || syncSetting.updated_at > localUpdatedAt) {
        logger.info(`[SyncSettings] 合并配置 ${key}: 共享文件 "${syncSetting.value}" > 本地 "${localValue}"`);
        // 清除共享文件中的配置（已合并）
        clearSyncSetting(key);
        return syncSetting.value;
    }
    
    // 本地更新时间更晚，不需要更新本地，但也不清除共享文件（对方可能还需要）
    return undefined;
}

// 导出模块
export const syncSettings = {
    read: readSyncSettings,
    write: writeSyncSetting,
    clear: clearSyncSetting,
    get: getSyncSetting,
    merge: mergeSettingOnStartup,
};
