import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';

let overrideUserDataDir: string | null = null;
let currentRemoteName: string | null = null;
let cachedWslWindowsAppDataDir: string | null | undefined;

export function setAntigravityUserDataDir(dir: string | null): void {
    overrideUserDataDir = dir && dir.trim().length > 0 ? dir : null;
}

export function setAntigravityRemoteName(remoteName: string | null): void {
    currentRemoteName = remoteName && remoteName.trim().length > 0 ? remoteName : null;
    cachedWslWindowsAppDataDir = undefined;
}

export function getAntigravityUserDataDir(): string | null {
    return overrideUserDataDir;
}

function resolveWslWindowsAppDataDir(): string {
    if (cachedWslWindowsAppDataDir !== undefined) {
        if (cachedWslWindowsAppDataDir) {
            return cachedWslWindowsAppDataDir;
        }
        throw new Error('Failed to resolve Windows APPDATA path from WSL');
    }

    try {
        // `cmd.exe /u` makes the built-in `echo` emit UTF-16LE, which preserves
        // non-ASCII Windows profile paths when this code runs inside WSL.
        const windowsAppData = childProcess.execFileSync(
            'cmd.exe',
            ['/d', '/u', '/c', 'echo', '%APPDATA%'],
            { encoding: 'utf16le' },
        ).replace(/^\uFEFF/, '').trim();

        if (!windowsAppData || windowsAppData.includes('%APPDATA%')) {
            throw new Error(`Unexpected APPDATA output: ${windowsAppData || '<empty>'}`);
        }

        const wslAppData = childProcess.execFileSync(
            'wslpath',
            ['-u', windowsAppData],
            { encoding: 'utf8' },
        ).trim();

        if (!wslAppData) {
            throw new Error('wslpath returned empty path');
        }

        cachedWslWindowsAppDataDir = wslAppData;
        return wslAppData;
    } catch (error) {
        cachedWslWindowsAppDataDir = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resolve Windows APPDATA path from WSL: ${message}`);
    }
}

export function getAntigravityStateDbPath(): string {
    if (currentRemoteName === 'wsl') {
        return path.posix.join(
            resolveWslWindowsAppDataDir(),
            'Antigravity',
            'User',
            'globalStorage',
            'state.vscdb',
        );
    }

    if (overrideUserDataDir) {
        return path.join(overrideUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    }

    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(
            homeDir,
            'Library',
            'Application Support',
            'Antigravity',
            'User',
            'globalStorage',
            'state.vscdb',
        );
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}
