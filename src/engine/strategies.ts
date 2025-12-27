/**
 * Antigravity Cockpit - 平台策略
 * 针对不同操作系统的进程检测策略
 */

import { logger } from '../shared/log_service';
import { PlatformStrategy, ProcessInfo } from '../shared/types';

/**
 * Windows 平台策略
 */
export class WindowsStrategy implements PlatformStrategy {
    /**
     * 判断命令行是否属于 Antigravity 进程
     * 精准匹配：必须同时满足以下条件：
     * 1. 必须有 --extension_server_port 参数
     * 2. 必须有 --csrf_token 参数
     * 3. 必须有 --app_data_dir antigravity 参数
     */
    private isAntigravityProcess(commandLine: string): boolean {
        // 条件1：必须包含 --extension_server_port 参数
        if (!commandLine.includes('--extension_server_port')) {
            return false;
        }

        // 条件2：必须包含 --csrf_token 参数
        if (!commandLine.includes('--csrf_token')) {
            return false;
        }

        // 条件3：必须有 --app_data_dir antigravity 参数（最可靠的标识）
        return /--app_data_dir\s+antigravity\b/i.test(commandLine);
    }

    /**
     * 按进程名获取进程列表命令
     * 仅使用 PowerShell
     */
    getProcessListCommand(processName: string): string {
        const utf8Header = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
        // 使用单引号包裹 Filter 参数，内部 name 值使用双单引号转义
        // chcp 65001 >nul 确保 CMD 环境以 UTF-8 运行，避免乱码
        return `chcp 65001 >nul && powershell -NoProfile -Command "${utf8Header}Get-CimInstance Win32_Process -Filter 'name=''${processName}''' | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
    }

    /**
     * 按关键字获取进程列表命令（查找所有包含 csrf_token 的进程）
     * 这是备用方案，当按进程名查找失败时使用
     */
    getProcessByKeywordCommand(): string {
        const utf8Header = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
        // chcp 65001 >nul 确保 CMD 环境以 UTF-8 运行
        return `chcp 65001 >nul && powershell -NoProfile -Command "${utf8Header}Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;
    }

    parseProcessInfo(stdout: string): ProcessInfo[] {
        logger.debug('[WindowsStrategy] Parsing JSON process info...');

        try {
            // 清理可能存在的非 JSON 杂质（虽然 chcp 65001 应该能解决大部分，但防御性编程）
            const jsonStart = stdout.indexOf('[');
            const jsonObjectStart = stdout.indexOf('{');
            let cleanStdout = stdout;

            if (jsonStart >= 0 || jsonObjectStart >= 0) {
                // 找到最早的 JSON 开始符号
                const start = (jsonStart >= 0 && jsonObjectStart >= 0) 
                    ? Math.min(jsonStart, jsonObjectStart) 
                    : Math.max(jsonStart, jsonObjectStart);
                cleanStdout = stdout.substring(start);
            }

            let data = JSON.parse(cleanStdout.trim());
            if (!Array.isArray(data)) {
                data = [data];
            }

            if (data.length === 0) {
                logger.debug('[WindowsStrategy] JSON array is empty');
                return [];
            }

            const totalCount = data.length;
            const candidates: ProcessInfo[] = [];

            for (const item of data) {
                const commandLine = item.CommandLine || '';
                if (!commandLine || !this.isAntigravityProcess(commandLine)) {
                    continue;
                }

                const pid = item.ProcessId;
                if (!pid) { continue; }

                const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (!tokenMatch?.[1]) {
                    logger.warn(`[WindowsStrategy] Cannot extract CSRF Token from PID ${pid}`);
                    continue;
                }

                const extensionPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];

                candidates.push({ pid, extensionPort, csrfToken });
            }

            logger.info(`[WindowsStrategy] Found ${totalCount} language_server processes, ${candidates.length} belong to Antigravity`);

            if (candidates.length === 0) {
                logger.warn('[WindowsStrategy] No valid Antigravity process found');
                return [];
            }

            return candidates;
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            // Log stdout preview for diagnosis
            const stdoutPreview = stdout.length > 200 ? stdout.substring(0, 200) + '...' : stdout;
            logger.debug(`[WindowsStrategy] JSON parse failed: ${error.message}. Output preview: ${stdoutPreview}`);
            return [];
        }
    }

    getPortListCommand(pid: number): string {
        return `chcp 65001 >nul && netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
    }

    parseListeningPorts(stdout: string): number[] {
        const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING/gi;
        const ports: number[] = [];
        let match;

        while ((match = portRegex.exec(stdout)) !== null) {
            const port = parseInt(match[1], 10);
            if (!ports.includes(port)) {
                ports.push(port);
            }
        }

        logger.debug(`[WindowsStrategy] Parsed ${ports.length} ports: ${ports.join(', ')}`);
        return ports.sort((a, b) => a - b);
    }

    getErrorMessages(): { processNotFound: string; commandNotAvailable: string; requirements: string[] } {
        return {
            processNotFound: 'language_server process not found',
            commandNotAvailable: 'PowerShell command failed; please check system permissions',
            requirements: [
                'Antigravity is running',
                'language_server_windows_x64.exe process is running',
                'The system has permission to run PowerShell and netstat commands',
            ],
        };
    }

    getDiagnosticCommand(): string {
        const utf8Header = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
        return `chcp 65001 >nul && powershell -NoProfile -Command "${utf8Header}Get-Process | Where-Object { $_.ProcessName -match 'language|antigravity' } | Select-Object Id,ProcessName,Path | Format-Table -AutoSize"`;
    }
}

/**
 * Unix (macOS/Linux) 平台策略
 */
export class UnixStrategy implements PlatformStrategy {
    private platform: string;
    private targetPid: number = 0;
    /** 可用的端口检测命令: 'lsof', 'ss', 或 'netstat' */
    private availablePortCommand: 'lsof' | 'ss' | 'netstat' | null = null;
    /** 是否已检测过命令可用性 */
    private portCommandChecked: boolean = false;

    constructor(platform: string) {
        this.platform = platform;
        logger.debug(`[UnixStrategy] Initialized, platform: ${platform}`);
    }

    /**
     * 检测系统上可用的端口检测命令
     * 优先顺序: lsof > ss > netstat
     */
    private async detectAvailablePortCommand(): Promise<void> {
        if (this.portCommandChecked) {
            return;
        }
        this.portCommandChecked = true;

        // 使用动态导入避免顶层依赖
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        const commands = ['lsof', 'ss', 'netstat'] as const;

        for (const cmd of commands) {
            try {
                await execAsync(`which ${cmd}`, { timeout: 3000 });
                this.availablePortCommand = cmd;
                logger.info(`[UnixStrategy] Port command available: ${cmd}`);
                return;
            } catch {
                // 命令不可用，继续尝试下一个
            }
        }

        logger.warn('[UnixStrategy] No port detection command available (lsof/ss/netstat)');
    }

    /**
     * 判断命令行是否属于 Antigravity 进程
     * 精准匹配：必须同时满足以下条件：
     * 1. 必须有 --extension_server_port 参数
     * 2. 必须有 --csrf_token 参数
     * 3. 必须有 --app_data_dir antigravity 参数
     */
    private isAntigravityProcess(commandLine: string): boolean {
        // 条件1：必须包含 --extension_server_port 参数
        if (!commandLine.includes('--extension_server_port')) {
            return false;
        }

        // 条件2：必须包含 --csrf_token 参数
        if (!commandLine.includes('--csrf_token')) {
            return false;
        }

        // 条件3：必须有 --app_data_dir antigravity 参数（最可靠的标识）
        return /--app_data_dir\s+antigravity\b/i.test(commandLine);
    }

    getProcessListCommand(processName: string): string {
        // 使用 ps -ww 保证命令行不被截断
        // -ww: 无限宽度
        // -eo: 自定义输出格式
        // pid,ppid,args: 进程ID、父进程ID、完整命令行
        return `ps -ww -eo pid,ppid,args | grep "${processName}" | grep -v grep`;
    }

    parseProcessInfo(stdout: string): ProcessInfo[] {
        logger.debug('[UnixStrategy] Parsing process info...');

        const lines = stdout.split('\n').filter(line => line.trim());
        logger.debug(`[UnixStrategy] Output contains ${lines.length} lines`);

        const currentPid = process.pid;
        const candidates: Array<{ pid: number; ppid: number; extensionPort: number; csrfToken: string }> = [];

        for (const line of lines) {
            // ps -ww -eo pid,ppid,args 格式: "  PID  PPID COMMAND..."
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) {
                continue;
            }

            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);
            const cmd = parts.slice(2).join(' ');

            if (isNaN(pid) || isNaN(ppid)) {
                continue;
            }

            const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/i);

            // 必须同时满足：有 csrf_token 且是 Antigravity 进程
            if (tokenMatch?.[1] && this.isAntigravityProcess(cmd)) {
                const extensionPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];
                candidates.push({ pid, ppid, extensionPort, csrfToken });
                logger.debug(`[UnixStrategy] Found candidate: PID=${pid}, PPID=${ppid}, ExtPort=${extensionPort}`);
            }
        }

        if (candidates.length === 0) {
            logger.warn('[UnixStrategy] No Antigravity process found');
            return [];
        }

        // Unix 平台排序策略：当前进程的子进程 > 其他进程
        // 为了提高成功率，我们将子进程排在第一位，但返回所有候选进程
        return candidates.sort((a, b) => {
            if (a.ppid === currentPid) { return -1; }
            if (b.ppid === currentPid) { return 1; }
            return 0;
        });
    }

    getPortListCommand(pid: number): string {
        // Save target PID
        this.targetPid = pid;

        // macOS: 优先使用 lsof
        if (this.platform === 'darwin') {
            return `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
        }

        // Linux: 根据检测到的可用命令选择
        switch (this.availablePortCommand) {
            case 'lsof':
                return `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
            case 'ss':
                return `ss -tlnp 2>/dev/null | grep "pid=${pid},"`;
            case 'netstat':
                return `netstat -tulpn 2>/dev/null | grep ${pid}`;
            default:
                // 回退：尝试多个命令
                return `ss -tlnp 2>/dev/null | grep "pid=${pid}," || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s" || netstat -tulpn 2>/dev/null | grep ${pid}`;
        }
    }

    /**
     * 确保端口检测命令可用（在获取端口列表前调用）
     */
    async ensurePortCommandAvailable(): Promise<void> {
        await this.detectAvailablePortCommand();
    }

    parseListeningPorts(stdout: string): number[] {
        const ports: number[] = [];

        if (this.platform === 'darwin') {
            // macOS lsof output format (already filtered by PID with grep):
            // language_ 15684 jieli   12u  IPv4 0x310104...    0t0  TCP *:53125 (LISTEN)

            const lines = stdout.split('\n');
            logger.debug(`[UnixStrategy] lsof output ${lines.length} lines (filtered PID: ${this.targetPid})`);

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                logger.debug(`[UnixStrategy] Parsing line: ${line.substring(0, 80)}...`);

                // Check if LISTEN state
                if (!line.includes('(LISTEN)')) {
                    continue;
                }

                // Extract port number - match *:PORT or IP:PORT format
                const portMatch = line.match(/[*\d.:]+:(\d+)\s+\(LISTEN\)/);
                if (portMatch) {
                    const port = parseInt(portMatch[1], 10);
                    if (!ports.includes(port)) {
                        ports.push(port);
                        logger.debug(`[UnixStrategy] ✅ Found port: ${port}`);
                    }
                }
            }

            logger.info(`[UnixStrategy] Parsed ${ports.length} target process ports: ${ports.join(', ') || '(none)'}`);
        } else {
            const ssRegex = /LISTEN\s+\d+\s+\d+\s+(?:\*|[\d.]+|\[[\da-f:]*\]):(\d+)/gi;
            let match;
            while ((match = ssRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }

            if (ports.length === 0) {
                const lsofRegex = /(?:TCP|UDP)\s+(?:\*|[\d.]+|\[[\da-f:]+\]):(\d+)\s+\(LISTEN\)/gi;
                while ((match = lsofRegex.exec(stdout)) !== null) {
                    const port = parseInt(match[1], 10);
                    if (!ports.includes(port)) {
                        ports.push(port);
                    }
                }
            }
        }

        logger.debug(`[UnixStrategy] Parsed ${ports.length} ports: ${ports.join(', ')}`);
        return ports.sort((a, b) => a - b);
    }

    getErrorMessages(): { processNotFound: string; commandNotAvailable: string; requirements: string[] } {
        return {
            processNotFound: 'Process not found',
            commandNotAvailable: 'Command check failed',
            requirements: ['lsof or netstat'],
        };
    }

    getDiagnosticCommand(): string {
        // 列出所有包含 'language' 或 'antigravity' 的进程
        return 'ps aux | grep -E \'language|antigravity\' | grep -v grep';
    }
}

// 保持向后兼容的导出
export type platform_strategy = PlatformStrategy;
