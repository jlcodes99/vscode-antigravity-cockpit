/**
 * Antigravity Cockpit - 进程猎手
 * 自动检测 Antigravity 进程并提取连接信息
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as process from 'process';
import { WindowsStrategy, UnixStrategy } from './strategies';
import { logger } from '../shared/log_service';
import { EnvironmentScanResult, PlatformStrategy } from '../shared/types';
import { TIMING, PROCESS_NAMES, API_ENDPOINTS } from '../shared/constants';

const execAsync = promisify(exec);

/**
 * 进程猎手类
 * 负责扫描系统进程，找到 Antigravity Language Server
 */
export class ProcessHunter {
    private strategy: PlatformStrategy;
    private targetProcess: string;

    constructor() {
        logger.debug('Initializing ProcessHunter...');
        logger.debug(`Platform: ${process.platform}, Arch: ${process.arch}`);

        if (process.platform === 'win32') {
            this.strategy = new WindowsStrategy();
            this.targetProcess = PROCESS_NAMES.windows;
            logger.debug('Using Windows Strategy');
        } else if (process.platform === 'darwin') {
            this.strategy = new UnixStrategy('darwin');
            this.targetProcess = process.arch === 'arm64' 
                ? PROCESS_NAMES.darwin_arm 
                : PROCESS_NAMES.darwin_x64;
            logger.debug('Using macOS Strategy');
        } else {
            this.strategy = new UnixStrategy('linux');
            this.targetProcess = PROCESS_NAMES.linux;
            logger.debug('Using Linux Strategy');
        }

        logger.debug(`Target Process: ${this.targetProcess}`);
    }

    /**
     * 扫描环境，查找 Antigravity 进程
     * @param maxAttempts 最大尝试次数（默认 3 次）
     */
    async scanEnvironment(maxAttempts: number = 3): Promise<EnvironmentScanResult | null> {
        logger.info(`Scanning environment, max attempts: ${maxAttempts}`);

        for (let i = 0; i < maxAttempts; i++) {
            logger.debug(`Attempt ${i + 1}/${maxAttempts}...`);

            try {
                const cmd = this.strategy.getProcessListCommand(this.targetProcess);
                logger.debug(`Executing: ${cmd}`);

                const { stdout, stderr } = await execAsync(cmd, { 
                    timeout: TIMING.PROCESS_CMD_TIMEOUT_MS, 
                });

                if (stderr) {
                    logger.warn(`StdErr: ${stderr}`);
                }

                const info = this.strategy.parseProcessInfo(stdout);

                if (info) {
                    logger.info(`✅ Found Process: PID=${info.pid}, ExtPort=${info.extensionPort}`);

                    const ports = await this.identifyPorts(info.pid);
                    logger.debug(`Listening Ports: ${ports.join(', ')}`);

                    if (ports.length > 0) {
                        const validPort = await this.verifyConnection(ports, info.csrfToken);

                        if (validPort) {
                            logger.info(`✅ Connection Logic Verified: ${validPort}`);
                            return {
                                extensionPort: info.extensionPort,
                                connectPort: validPort,
                                csrfToken: info.csrfToken,
                            };
                        }
                    }
                }
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                logger.error(`Attempt ${i + 1} failed: ${error.message}`);
                
                // Windows: WMIC 失败时自动切换到 PowerShell
                if (process.platform === 'win32' && this.strategy instanceof WindowsStrategy) {
                    const winStrategy = this.strategy as WindowsStrategy;
                    if (!winStrategy.isUsingPowershell() && 
                        (error.message.includes('not recognized') || 
                         error.message.includes('not found') ||
                         error.message.includes('不是内部或外部命令'))) {
                        logger.warn('WMIC command failed, switching to PowerShell...');
                        winStrategy.setUsePowershell(true);
                        // 不消耗重试次数，立即重试
                        i--;
                        continue;
                    }
                }
            }

            if (i < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, TIMING.PROCESS_SCAN_RETRY_MS));
            }
        }

        return null;
    }

    /**
     * 识别进程监听的端口
     */
    private async identifyPorts(pid: number): Promise<number[]> {
        try {
            // 确保端口检测命令可用（Unix 平台）
            if ('ensurePortCommandAvailable' in this.strategy) {
                await (this.strategy as any).ensurePortCommandAvailable();
            }
            
            const cmd = this.strategy.getPortListCommand(pid);
            const { stdout } = await execAsync(cmd);
            return this.strategy.parseListeningPorts(stdout);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Port identification failed: ${error.message}`);
            return [];
        }
    }

    /**
     * 验证端口连接
     */
    private async verifyConnection(ports: number[], token: string): Promise<number | null> {
        for (const port of ports) {
            if (await this.pingPort(port, token)) {
                return port;
            }
        }
        return null;
    }

    /**
     * 测试端口是否可用
     */
    private pingPort(port: number, token: string): Promise<boolean> {
        return new Promise(resolve => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: API_ENDPOINTS.GET_UNLEASH_DATA,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: TIMING.PROCESS_CMD_TIMEOUT_MS,
            };

            const req = https.request(options, res => resolve(res.statusCode === 200));
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }

    /**
     * 获取错误信息
     */
    getErrorMessages(): { processNotFound: string; commandNotAvailable: string; requirements: string[] } {
        return this.strategy.getErrorMessages();
    }
}

// 保持向后兼容
export type environment_scan_result = EnvironmentScanResult;
