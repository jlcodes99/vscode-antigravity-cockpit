/**
 * Cockpit Tools WebSocket 客户端
 * 用于与 antigravity-cockpit-tools 实时通信
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../shared/log_service';
import { getCockpitToolsSharedDir, isAntigravityWslRemote } from '../shared/antigravity_paths';

/** 服务配置文件 */
const SERVER_CONFIG_FILE = 'server.json';

/** 默认 WebSocket 端口 */
const DEFAULT_WS_PORT = 19528;

const RECONNECT_INTERVAL = 5000; // 5秒重连间隔
const RECONNECT_INTERVAL_MAX = 30000; // 最大重连间隔 30 秒
const PING_INTERVAL = 30000; // 30秒心跳间隔
const REQUEST_TIMEOUT = 10000; // 请求超时 10 秒

/** 服务配置结构（与 Rust 端保持一致） */
export interface ServerConfig {
    ws_port: number;
    version: string;
    pid: number;
    started_at: number;
}

/**
 * 读取服务配置文件
 * @returns 服务配置，如果文件不存在或读取失败则返回 null
 */
export function readServerConfig(): ServerConfig | null {
    try {
        const configPath = path.join(getCockpitToolsSharedDir(), SERVER_CONFIG_FILE);
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(content) as ServerConfig;
        }
    } catch (error) {
        logger.debug('[WS] 读取服务配置失败:', error);
    }
    return null;
}

function resolveWslWindowsHost(): string {
    try {
        const content = fs.readFileSync('/etc/resolv.conf', 'utf-8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*nameserver\s+([^\s#]+)\s*$/i);
            if (match?.[1]) {
                return match[1];
            }
        }
    } catch (error) {
        logger.debug('[WS] 读取 /etc/resolv.conf 失败，将回退 localhost:', error);
    }
    return '127.0.0.1';
}

function resolveWsHost(): string {
    if (isAntigravityWslRemote()) {
        return resolveWslWindowsHost();
    }
    return '127.0.0.1';
}

function formatWsHost(host: string): string {
    if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
        return `[${host}]`;
    }
    return host;
}

/**
 * 读取服务配置文件获取 WebSocket 端口
 * @returns WebSocket URL
 */
function getWsUrl(): string {
    const host = formatWsHost(resolveWsHost());
    const config = readServerConfig();
    if (config && config.ws_port > 0) {
        logger.debug(`[WS] 从配置文件读取端口: ${config.ws_port}, host=${host}`);
        return `ws://${host}:${config.ws_port}`;
    }
    
    // 回退到默认端口
    return `ws://${host}:${DEFAULT_WS_PORT}`;
}

// ============================================================================
// Types
// ============================================================================

export interface WsMessage {
    type: string;
    payload?: unknown;
}

export interface ReadyPayload {
    version: string;
}

export interface DataChangedPayload {
    source: string;
}

export interface AccountSwitchedPayload {
    account_id: string;
    email: string;
}

export interface SwitchErrorPayload {
    message: string;
}

export interface LanguageChangedPayload {
    language: string;
    source?: string;
}

export interface WakeupOverridePayload {
    enabled: boolean;
}

export type WsSwitchMode = 'default' | 'seamless' | 'auto';
export type WsTriggerType = 'manual' | 'auto';

export interface PluginSetSwitchModePayload {
    request_id?: string;
    switch_mode?: WsSwitchMode;
    source?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
}

export interface PluginSetSwitchModeResponsePayload {
    request_id?: string;
    success: boolean;
    applied_mode?: Exclude<WsSwitchMode, 'auto'>;
    error_message?: string;
    finished_at: string;
}

export interface PluginSwitchAccountPayload {
    request_id?: string;
    target_email?: string;
    switch_mode?: WsSwitchMode;
    trigger_type?: WsTriggerType;
    trigger_source?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
}

export interface PluginSwitchAccountResponsePayload {
    execution_id: string;
    request_id?: string;
    success: boolean;
    effective_mode: Exclude<WsSwitchMode, 'auto'>;
    from_email: string | null;
    to_email: string;
    duration_ms: number;
    error_code: string | null;
    error_message: string | null;
    finished_at: string;
}

/** 账号信息（来自 Cockpit Tools） */
export interface AccountInfo {
    id: string;
    email: string;
    name: string | null;
    is_current: boolean;
    disabled: boolean;
    has_fingerprint: boolean;
    last_used: number;
    subscription_tier?: string | null;
}

/** 账号信息（包含 Token，用于同步） */
export interface AccountTokenInfo extends AccountInfo {
    refresh_token: string;
    access_token: string;
    expires_at: number;
    project_id?: string | null;
}

/** 账号列表响应 */
export interface AccountsResponse {
    accounts: AccountInfo[];
    current_account_id: string | null;
}

/** 账号列表响应（包含 Token） */
export interface AccountsWithTokensResponse {
    accounts: AccountTokenInfo[];
    current_account_id: string | null;
}

// ============================================================================
// WebSocket Client
// ============================================================================

class CockpitToolsWsClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private _isConnected = false;
    private _version: string | null = null;
    private _shouldReconnect = true;
    
    // 重连相关
    private reconnectFailCount = 0;
    private lastWsUrl: string | null = null;
    
    // 请求等待队列
    private pendingRequests: Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }> = new Map();
    private requestIdCounter = 0;

    /**
     * 是否已连接
     */
    get isConnected(): boolean {
        return this._isConnected;
    }

    /**
     * Cockpit Tools 版本
     */
    get version(): string | null {
        return this._version;
    }

    /**
     * 连接到 Cockpit Tools
     */
    connect(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        this._shouldReconnect = true;
        this.doConnect();
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        this._shouldReconnect = false;
        this.cleanup();
    }

    /**
     * 发送消息
     */
    send(message: WsMessage): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.warn('[WS] 未连接，无法发送消息');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(message));
            return true;
        } catch (error) {
            logger.error('[WS] 发送消息失败:', error);
            return false;
        }
    }
    
    /**
     * 发送请求并等待响应
     */
    private sendRequest<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this.isConnected) {
                reject(new Error('未连接到 Cockpit Tools'));
                return;
            }
            
            const requestId = `${++this.requestIdCounter}`;
            
            // 设置超时
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('请求超时'));
            }, REQUEST_TIMEOUT);
            
            // 保存待处理请求
            this.pendingRequests.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timeout,
            });
            
            // 发送请求
            const message: WsMessage = {
                type,
                payload: { ...payload, request_id: requestId },
            };
            
            if (!this.send(message)) {
                this.pendingRequests.delete(requestId);
                clearTimeout(timeout);
                reject(new Error('发送请求失败'));
            }
        });
    }
    
    /**
     * 获取账号列表
     */
    async getAccounts(): Promise<AccountsResponse> {
        return this.sendRequest<AccountsResponse>('request.get_accounts');
    }

    /**
     * 获取账号列表（包含 Token）
     */
    async getAccountsWithTokens(): Promise<AccountsWithTokensResponse> {
        return this.sendRequest<AccountsWithTokensResponse>('request.get_accounts_with_tokens');
    }
    
    /**
     * 获取当前账号
     */
    async getCurrentAccount(): Promise<AccountInfo | null> {
        const result = await this.sendRequest<{ account: AccountInfo | null }>('request.get_current_account');
        return result.account;
    }

    /**
     * 请求切换账号
     */
    requestSwitchAccount(accountId: string): boolean {
        return this.send({
            type: 'request.switch_account',
            payload: { account_id: accountId },
        });
    }

    /**
     * 切换账号 (RPC)
     */
    async switchAccount(accountId: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await this.sendRequest<{ message: string }>('request.switch_account', { account_id: accountId });
            return { success: true, message: result.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * 通知数据已变更
     */
    notifyDataChanged(source: string): boolean {
        return this.send({
            type: 'request.data_changed',
            payload: { source },
        });
    }

    /**
     * 确保 WebSocket 已连接
     * 如果断开则立即尝试重连（读取最新配置）
     * 可用于手动触发重连，例如刷新配额时
     * @returns 当前是否已连接
     */
    ensureConnected(): boolean {
        if (this._isConnected) {
            return true;
        }
        
        logger.info('[WS] 检测到未连接，正在尝试强制恢复连接...');

        
        // 取消现有的重连定时器，立即尝试连接
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // 重置失败计数，立即尝试连接
        this.reconnectFailCount = 0;
        this._shouldReconnect = true;
        this.doConnect();
        
        return false;
    }

    /**
     * 等待 WebSocket 连接成功
     * 如果当前已连接，立即返回 true
     * 如果未连接，尝试强制重连并等待连接成功（带超时）
     * @param timeoutMs 超时时间（毫秒），默认 5000ms
     * @returns 是否成功连接
     */
    waitForConnection(timeoutMs = 5000): Promise<boolean> {
        if (this._isConnected) {
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            let resolved = false;
            let timer: NodeJS.Timeout | null = null;

            const onConnected = () => {
                if (resolved) { return; }
                resolved = true;
                if (timer) { clearTimeout(timer); }
                this.removeListener('connected', onConnected);
                logger.info('[WS] 等待连接成功，继续执行操作');
                resolve(true);
            };

            // 监听连接成功事件
            this.on('connected', onConnected);

            // 设置超时
            timer = setTimeout(() => {
                if (resolved) { return; }
                resolved = true;
                this.removeListener('connected', onConnected);
                logger.warn(`[WS] 等待连接超时 (${timeoutMs}ms)`);
                resolve(false);
            }, timeoutMs);

            // 触发重连
            this.ensureConnected();
        });
    }
    
    /**
     * 添加/更新账号到 Cockpit Tools
     * @param email 邮箱
     * @param refreshToken Refresh Token
     * @param accessToken Access Token（可选）
     * @param expiresAt 过期时间戳（可选）
     */
    async addAccount(
        email: string,
        refreshToken: string,
        accessToken?: string,
        expiresAt?: number,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const result = await this.sendRequest<{ message: string }>('request.add_account', {
                email,
                refresh_token: refreshToken,
                access_token: accessToken,
                expires_at: expiresAt,
            });
            return { success: true, message: result.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }
    
    /**
     * 删除账号（按邮箱）
     * @param email 邮箱
     */
    async deleteAccountByEmail(email: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await this.sendRequest<{ message: string }>('request.delete_account', {
                email,
            });
            return { success: true, message: result.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * 设置 Cockpit Tools 语言
     */
    async setLanguage(language: string, source = 'extension'): Promise<{ success: boolean; message: string }> {
        try {
            const result = await this.sendRequest<{ message: string }>('request.set_language', {
                language,
                source,
            });
            return { success: true, message: result.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }

    sendPluginSetSwitchModeResponse(payload: PluginSetSwitchModeResponsePayload): boolean {
        return this.send({
            type: 'response.plugin_set_switch_mode',
            payload,
        });
    }

    sendPluginSwitchAccountResponse(payload: PluginSwitchAccountResponsePayload): boolean {
        return this.send({
            type: 'response.plugin_switch_account',
            payload,
        });
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private doConnect(): void {
        try {
            // 每次重连都读取最新配置，确保端口变化后能正确连接
            const wsUrl = getWsUrl();
            
            // 检测端口是否变化
            if (this.lastWsUrl && this.lastWsUrl !== wsUrl) {
                logger.info(`[WS] 检测到端口变化: ${this.lastWsUrl} -> ${wsUrl}`);
            }
            this.lastWsUrl = wsUrl;
            
            logger.info(`[WS] 正在连接 ${wsUrl}... (尝试次数: ${this.reconnectFailCount + 1})`);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                logger.info('[WS] 连接成功');
                this._isConnected = true;
                this.reconnectFailCount = 0; // 重置失败计数
                this.emit('connected');
                this.startPing();
            };

            this.ws.onclose = (event) => {
                logger.info(`[WS] 连接关闭: ${event.code}`);
                this._isConnected = false;
                this._version = null;
                this.emit('disconnected');
                this.stopPing();
                this.rejectAllPendingRequests('连接已断开');
                this.reconnectFailCount++;
                this.scheduleReconnect();
            };

            this.ws.onerror = (error) => {
                logger.debug('[WS] 连接错误:', error);
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };
        } catch (error) {
            logger.error('[WS] 连接失败:', error);
            this.reconnectFailCount++;
            this.scheduleReconnect();
        }
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data) as WsMessage;
            const payload = message.payload as Record<string, unknown> | undefined;
            
            // 处理响应消息
            if (message.type.startsWith('response.') && payload?.request_id) {
                const requestId = payload.request_id as string;
                const pending = this.pendingRequests.get(requestId);
                if (pending) {
                    this.pendingRequests.delete(requestId);
                    clearTimeout(pending.timeout);
                    
                    if (message.type === 'response.error') {
                        pending.reject(new Error(payload.error as string || '未知错误'));
                    } else {
                        pending.resolve(payload);
                    }
                    return;
                }
            }
            
            switch (message.type) {
                case 'event.ready': {
                    const readyPayload = payload as unknown as ReadyPayload;
                    this._version = readyPayload.version;
                    logger.info(`[WS] Cockpit Tools 就绪, 版本: ${readyPayload.version}`);
                    this.emit('ready', readyPayload);
                    break;
                }

                case 'event.data_changed': {
                    const changedPayload = payload as unknown as DataChangedPayload;
                    logger.info(`[WS] 数据变更: ${changedPayload.source}`);
                    this.emit('dataChanged', changedPayload);
                    break;
                }

                case 'event.account_switched': {
                    const switchedPayload = payload as unknown as AccountSwitchedPayload;
                    logger.info(`[WS] 账号切换完成: ${switchedPayload.email}`);
                    this.emit('accountSwitched', switchedPayload);
                    break;
                }

                case 'event.switch_error': {
                    const errorPayload = payload as unknown as SwitchErrorPayload;
                    logger.error(`[WS] 切换失败: ${errorPayload.message}`);
                    this.emit('switchError', errorPayload);
                    break;
                }

                case 'event.language_changed': {
                    const languagePayload = payload as unknown as LanguageChangedPayload;
                    logger.info(`[WS] 语言变更: ${languagePayload.language}`);
                    this.emit('languageChanged', languagePayload);
                    break;
                }

                case 'event.wakeup_override': {
                    const overridePayload = payload as unknown as WakeupOverridePayload;
                    logger.info(`[WS] 唤醒互斥状态: enabled=${overridePayload.enabled}`);
                    this.emit('wakeupOverride', overridePayload);
                    break;
                }

                case 'event.plugin_set_switch_mode': {
                    const modePayload = payload as unknown as PluginSetSwitchModePayload;
                    logger.info(
                        `[WS] 收到外部切换模式请求: request_id=${modePayload.request_id ?? 'none'}, mode=${modePayload.switch_mode ?? 'none'}`,
                    );
                    this.emit('pluginSetSwitchMode', modePayload);
                    break;
                }

                case 'event.plugin_switch_account': {
                    const switchPayload = payload as unknown as PluginSwitchAccountPayload;
                    logger.info(
                        `[WS] 收到外部切号请求: request_id=${switchPayload.request_id ?? 'none'}, target=${switchPayload.target_email ?? 'none'}, mode=${switchPayload.switch_mode ?? 'auto'}`,
                    );
                    this.emit('pluginSwitchAccount', switchPayload);
                    break;
                }

                case 'pong':
                    // 心跳响应，忽略
                    break;

                default:
                    logger.debug(`[WS] 未知消息类型: ${message.type}`);
            }
        } catch (error) {
            logger.error('[WS] 解析消息失败:', error);
        }
    }
    
    private rejectAllPendingRequests(reason: string): void {
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    private scheduleReconnect(): void {
        if (!this._shouldReconnect) {
            return;
        }

        if (this.reconnectTimer) {
            return;
        }

        // 渐进式退避：失败次数越多，等待时间越长
        // 5s -> 10s -> 15s -> 20s -> 25s -> 30s (最大)
        const delay = Math.min(
            RECONNECT_INTERVAL + (this.reconnectFailCount * 5000),
            RECONNECT_INTERVAL_MAX,
        );
        
        logger.info(`[WS] ${delay / 1000}秒后重连... (失败次数: ${this.reconnectFailCount})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect();
        }, delay);
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            this.send({ type: 'ping' });
        }, PING_INTERVAL);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private cleanup(): void {
        this.stopPing();
        this.rejectAllPendingRequests('连接已关闭');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.close();
            this.ws = null;
        }

        this._isConnected = false;
        this._version = null;
    }
}

// 导出单例
export const cockpitToolsWs = new CockpitToolsWsClient();
