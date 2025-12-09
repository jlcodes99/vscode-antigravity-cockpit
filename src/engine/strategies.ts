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
     */
    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) {
            return true;
        }
        return false;
    }

    getProcessListCommand(processName: string): string {
        if (this.usePowershell) {
            return `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        }
        return `wmic process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
    }

    parseProcessInfo(stdout: string): ProcessInfo | null {
        logger.debug('[WindowsStrategy] Parsing process info...');

        if (this.usePowershell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        logger.debug('[WindowsStrategy] JSON array is empty');
                        return null;
                    }
                    const totalCount = data.length;
                    const antigravityProcesses = data.filter(
                        (item: { CommandLine?: string }) => 
                            item.CommandLine && this.isAntigravityProcess(item.CommandLine),
                    );
                    logger.info(`[WindowsStrategy] Found ${totalCount} language_server processes, ${antigravityProcesses.length} belong to Antigravity`);

                    if (antigravityProcesses.length === 0) {
                        logger.warn('[WindowsStrategy] No Antigravity process found, skipping non-Antigravity processes');
                        return null;
                    }
                    if (totalCount > 1) {
                        logger.debug(`[WindowsStrategy] Selecting Antigravity process PID: ${antigravityProcesses[0].ProcessId}`);
                    }
                    data = antigravityProcesses[0];
                } else {
                    if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) {
                        logger.warn('[WindowsStrategy] Single process is not Antigravity, skipping');
                        return null;
                    }
                    logger.info(`[WindowsStrategy] Found 1 Antigravity process, PID: ${data.ProcessId}`);
                }

                const commandLine = data.CommandLine || '';
                const pid = data.ProcessId;

                if (!pid) {
                    logger.warn('[WindowsStrategy] Cannot get PID');
                    return null;
                }

                const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (!tokenMatch?.[1]) {
                    logger.warn('[WindowsStrategy] Cannot extract CSRF Token from command line');
                    logger.debug(`[WindowsStrategy] Command line: ${commandLine.substring(0, 200)}...`);
                    return null;
                }

                const extensionPort = portMatch?.[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];

                logger.debug(`[WindowsStrategy] Parse success: PID=${pid}, ExtPort=${extensionPort}`);
                return { pid, extensionPort, csrfToken };
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                logger.debug(`[WindowsStrategy] JSON parse failed: ${error.message}`);
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
            return null;
        }

        logger.info(`[WindowsStrategy] WMIC: Found ${candidates.length} Antigravity processes, using PID: ${candidates[0].pid}`);
        return candidates[0];
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
}

/**
 * Unix (macOS/Linux) 平台策略
 */
export class UnixStrategy implements PlatformStrategy {
    private platform: string;
    private targetPid: number = 0;

    constructor(platform: string) {
        this.platform = platform;
        logger.debug(`[UnixStrategy] Initialized, platform: ${platform}`);
    }

    getProcessListCommand(processName: string): string {
        return `pgrep -fl ${processName}`;
    }

    parseProcessInfo(stdout: string): ProcessInfo | null {
        logger.debug('[UnixStrategy] Parsing process info...');

        const lines = stdout.split('\n');
        logger.debug(`[UnixStrategy] Output contains ${lines.length} lines`);

        for (const line of lines) {
            if (line.includes('--extension_server_port')) {
                logger.debug(`[UnixStrategy] Found matching line: ${line.substring(0, 100)}...`);

                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[0], 10);
                const cmd = line.substring(parts[0].length).trim();

                const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);

                if (!tokenMatch?.[1]) {
                    logger.warn('[UnixStrategy] Cannot extract CSRF Token from command line');
                    continue;
                }

                logger.debug(`[UnixStrategy] Parse success: PID=${pid}, ExtPort=${portMatch?.[1] || 0}`);

                // Save target PID for later port filtering
                this.targetPid = pid;

                return {
                    pid,
                    extensionPort: portMatch ? parseInt(portMatch[1], 10) : 0,
                    csrfToken: tokenMatch[1],
                };
            }
        }

        logger.warn('[UnixStrategy] No line containing --extension_server_port found in output');
        return null;
    }

    getPortListCommand(pid: number): string {
        // Save target PID
        this.targetPid = pid;

        if (this.platform === 'darwin') {
            // macOS: Use lsof to list all TCP LISTEN ports, then filter by PID with grep
            return `lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
        }
        return `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E "^\\S+\\s+${pid}\\s"`;
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
}

// 保持向后兼容的导出
export type platform_strategy = PlatformStrategy;
