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
import { EnvironmentScanResult, PlatformStrategy, ProcessInfo } from '../shared/types';
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

        // 第一阶段：按进程名查找
        const resultByName = await this.scanByProcessName(maxAttempts);
        if (resultByName) {
            return resultByName;
        }

        // 第二阶段：按关键字查找（备用方案）
        logger.info('Process name search failed, trying keyword search (csrf_token)...');
        const resultByKeyword = await this.scanByKeyword();
        if (resultByKeyword) {
            return resultByKeyword;
        }

        // 所有方法都失败了，执行诊断
        await this.runDiagnostics();

        return null;
    }

    /**
     * 按进程名扫描
     */
    private async scanByProcessName(maxAttempts: number): Promise<EnvironmentScanResult | null> {
        let powershellTimeoutRetried = false; // 追踪 PowerShell 超时是否已重试过
        let strategySwitchCount = 0; // 追踪 PowerShell/WMIC 切换次数，防止无限循环
        const MAX_STRATEGY_SWITCHES = 2; // 最多切换 2 次（PowerShell → WMIC → PowerShell）

        for (let i = 0; i < maxAttempts; i++) {
            logger.debug(`Attempt ${i + 1}/${maxAttempts} (by process name)...`);

            try {
                const cmd = this.strategy.getProcessListCommand(this.targetProcess);
                logger.debug(`Executing: ${cmd}`);

                const { stdout, stderr } = await execAsync(cmd, {
                    timeout: TIMING.PROCESS_CMD_TIMEOUT_MS,
                });

                // 记录 stderr 以便调试
                if (stderr && stderr.trim()) {
                    logger.warn(`Command stderr: ${stderr.substring(0, 500)}`);
                }

                // 检查 stdout 是否为空或仅包含空白
                if (!stdout || !stdout.trim()) {
                    logger.debug('Command returned empty output, process may not be running');
                    continue;
                }

                const candidates = this.strategy.parseProcessInfo(stdout);

                if (candidates && candidates.length > 0) {
                    logger.info(`Found ${candidates.length} candidate process(es)`);
                    
                    // 遍历所有候选进程尝试连接
                    for (const info of candidates) {
                        logger.info(`🔍 Checking Process: PID=${info.pid}, ExtPort=${info.extensionPort}`);
                        const result = await this.verifyAndConnect(info);
                        if (result) {
                            return result;
                        }
                    }
                    logger.warn('❌ All candidates failed verification in this attempt');
                }
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                const errorMsg = error.message.toLowerCase();
                
                // 构建详细的错误信息
                const detailMsg = `Attempt ${i + 1} failed: ${error.message}`;
                logger.error(detailMsg);

                // Windows 特定处理
                if (process.platform === 'win32' && this.strategy instanceof WindowsStrategy) {
                    const winStrategy = this.strategy as WindowsStrategy;
                    const currentlyUsingPowershell = winStrategy.isUsingPowershell();
                    
                    // 检测 PowerShell 执行策略问题
                    if (errorMsg.includes('cannot be loaded because running scripts is disabled') ||
                        errorMsg.includes('executionpolicy') ||
                        errorMsg.includes('禁止运行脚本')) {
                        logger.error('⚠️ PowerShell execution policy may be blocking scripts. Try running: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned');
                    }
                    
                    // 检测 WMI 服务问题
                    if (errorMsg.includes('rpc server') || 
                        errorMsg.includes('wmi') ||
                        errorMsg.includes('invalid class') ||
                        errorMsg.includes('无效类')) {
                        logger.error('⚠️ WMI service may not be running. Try: net start winmgmt');
                    }

                    // 策略切换逻辑（防止无限循环）
                    if (strategySwitchCount < MAX_STRATEGY_SWITCHES) {
                        // 检测需要切换策略的错误
                        const needsSwitch = 
                            errorMsg.includes('not recognized') ||
                            errorMsg.includes('not found') ||
                            errorMsg.includes('不是内部或外部命令') ||
                            errorMsg.includes('无法识别') ||
                            errorMsg.includes('cmdlet') ||
                            errorMsg.includes('get-ciminstance') ||
                            errorMsg.includes('exception') ||
                            errorMsg.includes('异常');
                        
                        if (needsSwitch) {
                            const newStrategy = !currentlyUsingPowershell;
                            logger.warn(`${currentlyUsingPowershell ? 'PowerShell' : 'WMIC'} command failed, switching to ${newStrategy ? 'PowerShell' : 'WMIC'}...`);
                            winStrategy.setUsePowershell(newStrategy);
                            strategySwitchCount++;
                            // 不消耗重试次数，立即重试
                            i--;
                            continue;
                        }
                    }

                    // PowerShell 超时特殊处理：首次超时不消耗重试次数
                    if (currentlyUsingPowershell &&
                        !powershellTimeoutRetried &&
                        (errorMsg.includes('timeout') ||
                         errorMsg.includes('timed out') ||
                         errorMsg.includes('超时'))) {
                        logger.warn('PowerShell command timed out (likely cold start), retrying with longer wait...');
                        powershellTimeoutRetried = true;
                        // 不消耗重试次数，给 PowerShell 预热时间后重试
                        i--;
                        await new Promise(r => setTimeout(r, 2000)); // 等待 2 秒让 PowerShell 预热
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
     * 按关键字扫描（查找包含 csrf_token 的进程）
     */
    private async scanByKeyword(): Promise<EnvironmentScanResult | null> {
        // 仅 Windows PowerShell 支持按关键字查找
        if (process.platform !== 'win32' || !(this.strategy instanceof WindowsStrategy)) {
            return null;
        }

        const winStrategy = this.strategy as WindowsStrategy;
        if (!winStrategy.isUsingPowershell()) {
            return null;
        }

        try {
            const cmd = winStrategy.getProcessByKeywordCommand();
            logger.debug(`Keyword search command: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd, { 
                timeout: TIMING.PROCESS_CMD_TIMEOUT_MS, 
            });

            if (stderr) {
                logger.warn(`StdErr: ${stderr}`);
            }

            const candidates = this.strategy.parseProcessInfo(stdout);

            if (candidates && candidates.length > 0) {
                logger.info(`Found ${candidates.length} keyword candidate(s)`);
                
                for (const info of candidates) {
                    logger.info(`🔍 Checking Keyword Candidate: PID=${info.pid}`);
                    const result = await this.verifyAndConnect(info);
                    if (result) {
                        return result;
                    }
                }
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Keyword search failed: ${error.message}`);
        }

        return null;
    }

    /**
     * 验证并建立连接
     */
    private async verifyAndConnect(info: ProcessInfo): Promise<EnvironmentScanResult | null> {
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

        return null;
    }

    /**
     * 运行诊断命令，列出所有相关进程
     */
    private async runDiagnostics(): Promise<void> {
        logger.warn('⚠️ All scan attempts failed, running diagnostics...');
        logger.info(`Target process name: ${this.targetProcess}`);
        logger.info(`Platform: ${process.platform}, Arch: ${process.arch}`);
        
        // Windows 特定诊断
        if (process.platform === 'win32') {
            logger.info('📋 Windows Troubleshooting Tips:');
            logger.info('  1. Ensure Antigravity/Windsurf is running');
            logger.info('  2. Check if language_server_windows_x64.exe is in Task Manager');
            logger.info('  3. Try restarting Antigravity/VS Code');
            logger.info('  4. If PowerShell errors occur, try: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned');
            logger.info('  5. If WMI errors occur, try: net start winmgmt (run as admin)');
        }
        
        try {
            const diagCmd = this.strategy.getDiagnosticCommand();
            logger.debug(`Diagnostic command: ${diagCmd}`);
            
            const { stdout, stderr } = await execAsync(diagCmd, { timeout: 10000 });
            
            if (stdout && stdout.trim()) {
                logger.info(`📋 Related processes found:\n${stdout.substring(0, 2000)}`);
            } else {
                logger.warn('❌ No related processes found (language_server/antigravity)');
                logger.info('💡 This usually means Antigravity is not running or the process name has changed.');
            }
            
            if (stderr && stderr.trim()) {
                logger.warn(`Diagnostic stderr: ${stderr.substring(0, 500)}`);
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Diagnostic command failed: ${error.message}`);
            
            // 为用户提供进一步的诊断建议
            if (process.platform === 'win32') {
                logger.info('💡 Try running this command manually in PowerShell to debug:');
                logger.info('   Get-Process | Where-Object { $_.ProcessName -match "language|antigravity" }');
            } else {
                logger.info('💡 Try running this command manually in Terminal to debug:');
                logger.info('   ps aux | grep -E "language|antigravity"');
            }
        }
    }

    /**
     * 识别进程监听的端口
     */
    private async identifyPorts(pid: number): Promise<number[]> {
        try {
            // 确保端口检测命令可用（Unix 平台）
            if (this.strategy instanceof UnixStrategy) {
                await this.strategy.ensurePortCommandAvailable();
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
