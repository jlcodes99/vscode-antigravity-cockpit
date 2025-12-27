/**
 * Antigravity Cockpit - 轻量级错误上报服务
 * 直接使用 Sentry API，不依赖 SDK，体积更小
 */

import * as https from 'https';
import * as vscode from 'vscode';
import * as os from 'os';

// Sentry DSN - 构建时通过 esbuild define 注入
const SENTRY_DSN = process.env.SENTRY_DSN || '';

let telemetryEnabled = true;
let extensionVersion = 'unknown';

// 解析 DSN
interface SentryConfig {
    publicKey: string;
    host: string;
    projectId: string;
}

function parseDsn(dsn: string): SentryConfig | null {
    if (!dsn) {
        return null;
    }
    try {
        // DSN 格式: https://<public_key>@<host>/<project_id>
        const url = new URL(dsn);
        const publicKey = url.username;
        const host = url.host;
        const projectId = url.pathname.replace('/', '');
        return { publicKey, host, projectId };
    } catch {
        return null;
    }
}

const sentryConfig = parseDsn(SENTRY_DSN);

/**
 * 初始化错误上报服务
 */
export function initErrorReporter(version: string): void {
    extensionVersion = version;
    
    // 检查用户是否禁用了遥测
    const config = vscode.workspace.getConfiguration('agCockpit');
    telemetryEnabled = config.get<boolean>('telemetryEnabled', true);
    
    // 同时尊重 VS Code 的全局遥测设置
    const vscodeConfig = vscode.workspace.getConfiguration('telemetry');
    const vscodeLevel = vscodeConfig.get<string>('telemetryLevel', 'all');
    if (vscodeLevel === 'off') {
        telemetryEnabled = false;
    }
    
    if (!telemetryEnabled) {
        console.log('[ErrorReporter] Telemetry disabled by user');
        return;
    }

    if (!sentryConfig) {
        console.log('[ErrorReporter] Sentry DSN not configured');
        return;
    }

    console.log('[ErrorReporter] Lightweight error reporter initialized');
}

/**
 * 错误分类 - 帮助快速区分用户环境问题 vs 插件 Bug
 */
type ErrorCategory = 
    | 'network_timeout'      // 网络超时 - 用户环境
    | 'connection_refused'   // 连接拒绝 - 服务未启动
    | 'dns_failure'         // DNS 解析失败 - 网络问题
    | 'proxy_error'         // 代理问题 - 用户环境
    | 'permission_denied'   // 权限问题 - 用户环境
    | 'cmd_timeout'         // 命令超时 - 系统卡顿
    | 'parse_error'         // 解析错误 - 插件 Bug
    | 'null_reference'      // 空引用 - 插件 Bug
    | 'process_not_found'   // 进程未找到 - 用户环境
    | 'unknown';            // 未知

/**
 * 根据错误消息自动分类
 */
function classifyError(error: Error): ErrorCategory {
    const msg = error.message.toLowerCase();
    
    // 网络相关（用户环境）
    if (msg.includes('etimedout') || msg.includes('timed out')) {
        return 'network_timeout';
    }
    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
        return 'connection_refused';
    }
    if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
        return 'dns_failure';
    }
    if (msg.includes('proxy') || msg.includes('407')) {
        return 'proxy_error';
    }
    
    // 权限/系统相关（用户环境）
    if (msg.includes('permission') || msg.includes('access denied') || msg.includes('eacces')) {
        return 'permission_denied';
    }
    if (msg.includes('timeout') && (msg.includes('command') || msg.includes('powershell'))) {
        return 'cmd_timeout';
    }
    if (msg.includes('process') && (msg.includes('not found') || msg.includes('no matching'))) {
        return 'process_not_found';
    }
    
    // 代码问题（插件 Bug）
    if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected token')) {
        return 'parse_error';
    }
    if (msg.includes('undefined') || msg.includes('null') || msg.includes('cannot read prop')) {
        return 'null_reference';
    }
    
    return 'unknown';
}

/**
 * 获取代理配置状态
 */
function getProxyStatus(): { configured: boolean; type: string } {
    try {
        const httpConfig = vscode.workspace.getConfiguration('http');
        const proxy = httpConfig.get<string>('proxy', '');
        if (proxy) {
            return { configured: true, type: 'http.proxy' };
        }
        
        // 检查环境变量
        if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
            return { configured: true, type: 'env_var' };
        }
        
        return { configured: false, type: 'none' };
    } catch {
        return { configured: false, type: 'unknown' };
    }
}

/**
 * 构建 Sentry 事件 - 包含增强的诊断信息
 */
function buildEvent(error: Error, context?: Record<string, unknown>): object {
    const errorCategory = classifyError(error);
    const proxyStatus = getProxyStatus();
    
    // 判断是否可能是用户环境问题
    const likelyUserEnvIssue = [
        'network_timeout', 'connection_refused', 'dns_failure', 
        'proxy_error', 'permission_denied', 'cmd_timeout', 'process_not_found'
    ].includes(errorCategory);
    
    return {
        event_id: generateEventId(),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        release: `antigravity-cockpit@${extensionVersion}`,
        environment: 'production',
        // 标签 - 用于 Sentry 筛选和分组
        tags: {
            error_category: errorCategory,
            likely_user_env: likelyUserEnvIssue ? 'yes' : 'no',
            proxy_configured: proxyStatus.configured ? 'yes' : 'no',
            os_type: os.platform(),
        },
        // 上下文 - 详细诊断信息
        contexts: {
            os: {
                name: os.platform(),
                version: os.release(),
            },
            vscode: {
                version: vscode.version,
            },
            diagnostic: {
                error_category: errorCategory,
                proxy_status: proxyStatus,
                node_version: process.version,
                arch: os.arch(),
                raw_stack: error.stack,  // 原始堆栈，方便人眼阅读
            },
            ...(context ? { custom: context } : {}),
        },
        exception: {
            values: [{
                type: error.name,
                value: error.message,
                stacktrace: parseStacktrace(error.stack),
            }],
        },
    };
}

/**
 * 生成事件 ID
 */
function generateEventId(): string {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 解析堆栈
 */
function parseStacktrace(stack?: string): object | undefined {
    if (!stack) {
        return undefined;
    }
    
    const frames = stack.split('\n')
        .slice(1) // 跳过第一行（错误消息）
        .map(line => {
            const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
            if (match) {
                return {
                    function: match[1],
                    filename: match[2],
                    lineno: parseInt(match[3], 10),
                    colno: parseInt(match[4], 10),
                };
            }
            return null;
        })
        .filter(Boolean)
        .reverse(); // Sentry 期望最新的帧在最后
    
    return frames.length > 0 ? { frames } : undefined;
}

/**
 * 发送事件到 Sentry
 */
function sendEvent(event: object): void {
    if (!sentryConfig) {
        return;
    }

    const data = JSON.stringify(event);
    
    const options: https.RequestOptions = {
        hostname: sentryConfig.host,
        port: 443,
        path: `/api/${sentryConfig.projectId}/store/`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${sentryConfig.publicKey}, sentry_client=antigravity-cockpit/1.0`,
            'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
    };

    const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
            console.log('[ErrorReporter] Event sent successfully');
        }
    });

    req.on('error', () => {
        // 静默失败，不影响主程序
    });

    req.on('timeout', () => {
        req.destroy();
    });

    req.write(data);
    req.end();
}

/**
 * 上报错误
 */
export function captureError(error: Error, context?: Record<string, unknown>): void {
    if (!telemetryEnabled || !sentryConfig) {
        return;
    }

    try {
        const event = buildEvent(error, context);
        sendEvent(event);
    } catch {
        // 静默失败
    }
}

/**
 * 上报消息
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (!telemetryEnabled || !sentryConfig) {
        return;
    }

    try {
        const event = {
            event_id: generateEventId(),
            timestamp: new Date().toISOString(),
            platform: 'node',
            level,
            release: `antigravity-cockpit@${extensionVersion}`,
            message,
            // 不收集 user 信息
        };
        sendEvent(event);
    } catch {
        // 静默失败
    }
}

/**
 * 刷新待发送的事件（兼容接口，轻量版不需要）
 */
export async function flushEvents(): Promise<void> {
    // 轻量版使用异步请求，不需要等待
    return Promise.resolve();
}
