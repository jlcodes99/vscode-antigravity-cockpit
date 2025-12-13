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
    private usePowershell: boolean = true;

    setUsePowershell(use: boolean): void {
        this.usePowershell = use;
    }

    isUsingPowershell(): boolean {
        return this.usePowershell;
    }

    /**
     * 判断命令行是否属于 Antigravity 进程
     * 精准匹配：必须包含 --app_data_dir antigravity 参数
     */
    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        
        // 必须包含 csrf_token（基本标识）
        if (!commandLine.includes('csrf_token')) {
            return false;
        }
        
        // 精准特征：--app_data_dir antigravity
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }
        
        // 路径特征：包含 \antigravity\ 或 /antigravity/
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) {
            return true;
        }
        
        return false;
    }

    /**
     * 按进程名获取进程列表命令
     */
    getProcessListCommand(processName: string): string {
        if (this.usePowershell) {
            // 使用单引号包裹 Filter 参数，内部 name 值使用双单引号转义
            return `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'name=''${processName}''' | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        }
        return `wmic process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
    }

    /**
     * 按关键字获取进程列表命令（查找所有包含 csrf_token 的进程）
     * 这是备用方案，当按进程名查找失败时使用
     */
    getProcessByKeywordCommand(): string {
        if (this.usePowershell) {
            // 查找所有 CommandLine 包含 csrf_token 的进程
            return 'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'csrf_token\' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"';
        }
        // WMIC 不支持按 CommandLine 筛选，返回所有进程
        return 'wmic process get ProcessId,Name,CommandLine /format:list';
    }

    parseProcessInfo(stdout: string): ProcessInfo[] {
        logger.debug('[WindowsStrategy] Parsing process info...');

        if (this.usePowershell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());
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
                    if (!pid) {continue;}

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
                logger.debug(`[WindowsStrategy] JSON parse failed: ${error.message}`);
                return [];
            }
        }

        // WMIC format parsing
        logger.debug('[WindowsStrategy] Trying WMIC format parsing...');
        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);

        const candidates: ProcessInfo[] = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const commandLine = commandLineMatch[1].trim();

            if (!this.isAntigravityProcess(commandLine)) {
                continue;
            }

            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (!tokenMatch?.[1]) {
                continue;
            }

            const pid = parseInt(pidMatch[1], 10);
            const extensionPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : 0;
            const csrfToken = tokenMatch[1];

            candidates.push({ pid, extensionPort, csrfToken });
        }

        if (candidates.length === 0) {
            logger.warn('[WindowsStrategy] WMIC: No Antigravity process found');
            return [];
        }

        logger.info(`[WindowsStrategy] WMIC: Found ${candidates.length} Antigravity candidates`);
        return candidates;
    }

    getPortListCommand(pid: number): string {
        return `netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
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
            commandNotAvailable: this.usePowershell
                ? 'PowerShell command failed; please check system permissions'
                : 'wmic/PowerShell command unavailable; please check the system environment',
            requirements: [
                'Antigravity is running',
                'language_server_windows_x64.exe process is running',
                this.usePowershell
                    ? 'The system has permission to run PowerShell and netstat commands'
                    : 'The system has permission to run wmic/PowerShell and netstat commands (auto-fallback supported)',
            ],
        };
    }

    getDiagnosticCommand(): string {
        // 列出所有包含 'language' 或 'antigravity' 的进程
        if (this.usePowershell) {
            return 'powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match \'language|antigravity\' } | Select-Object Id,ProcessName,Path | Format-Table -AutoSize"';
        }
        return 'wmic process where "name like \'%language%\' or name like \'%antigravity%\'" get ProcessId,Name,CommandLine /format:list';
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
     */
    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        // 检查 --app_data_dir antigravity 参数
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }
        // 检查路径中是否包含 antigravity
        if (lowerCmd.includes('/antigravity/') || lowerCmd.includes('\\antigravity\\')) {
            return true;
        }
        return false;
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
            if (a.ppid === currentPid) {return -1;}
            if (b.ppid === currentPid) {return 1;}
            return 0;
        });
    }

    getPortListCommand(pid: number): string {
        // Save target PID
        this.targetPid = pid;

        // macOS: 优先使用 lsof
        if (this.platform === 'darwin') {
            return `lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
        }

        // Linux: 根据检测到的可用命令选择
        switch (this.availablePortCommand) {
            case 'lsof':
                return `lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
            case 'ss':
                return `ss -tlnp 2>/dev/null | grep "pid=${pid},"`;
            case 'netstat':
                return `netstat -tulpn 2>/dev/null | grep ${pid}`;
            default:
                // 回退：尝试多个命令
                return `ss -tlnp 2>/dev/null | grep "pid=${pid}," || lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s" || netstat -tulpn 2>/dev/null | grep ${pid}`;
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
