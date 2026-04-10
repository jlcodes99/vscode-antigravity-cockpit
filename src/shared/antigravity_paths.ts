import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';

let overrideUserDataDir: string | null = null;
let currentRemoteName: string | null = null;
let cachedWslWindowsAppDataDir: string | null | undefined;
let cachedWslWindowsUserProfileDir: string | null | undefined;

function resolveWslWindowsPathFromEnv(varName: 'APPDATA' | 'USERPROFILE'): string {
    const windowsValue = childProcess.execFileSync(
        'cmd.exe',
        ['/d', '/u', '/c', 'echo', `%${varName}%`],
        { encoding: 'utf16le' },
    ).replace(/^\uFEFF/, '').trim();

    if (!windowsValue || windowsValue.includes(`%${varName}%`)) {
        throw new Error(`Unexpected ${varName} output: ${windowsValue || '<empty>'}`);
    }

    const wslPath = childProcess.execFileSync(
        'wslpath',
        ['-u', windowsValue],
        { encoding: 'utf8' },
    ).trim();

    if (!wslPath) {
        throw new Error(`wslpath returned empty path for ${varName}`);
    }

    return wslPath;
}

export function setAntigravityUserDataDir(dir: string | null): void {
    overrideUserDataDir = dir && dir.trim().length > 0 ? dir : null;
}

export function setAntigravityRemoteName(remoteName: string | null): void {
    currentRemoteName = remoteName && remoteName.trim().length > 0 ? remoteName : null;
    cachedWslWindowsAppDataDir = undefined;
    cachedWslWindowsUserProfileDir = undefined;
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
        const wslAppData = resolveWslWindowsPathFromEnv('APPDATA');
        cachedWslWindowsAppDataDir = wslAppData;
        return wslAppData;
    } catch (error) {
        cachedWslWindowsAppDataDir = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resolve Windows APPDATA path from WSL: ${message}`);
    }
}

function resolveWslWindowsUserProfileDir(): string {
    if (cachedWslWindowsUserProfileDir !== undefined) {
        if (cachedWslWindowsUserProfileDir) {
            return cachedWslWindowsUserProfileDir;
        }
        throw new Error('Failed to resolve Windows USERPROFILE path from WSL');
    }

    try {
        const wslUserProfile = resolveWslWindowsPathFromEnv('USERPROFILE');
        cachedWslWindowsUserProfileDir = wslUserProfile;
        return wslUserProfile;
    } catch (error) {
        cachedWslWindowsUserProfileDir = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resolve Windows USERPROFILE path from WSL: ${message}`);
    }
}

export function isAntigravityWslRemote(): boolean {
    return currentRemoteName === 'wsl';
}

export function getCockpitToolsSharedDir(): string {
    if (isAntigravityWslRemote()) {
        return path.posix.join(resolveWslWindowsUserProfileDir(), '.antigravity_cockpit');
    }
    return path.join(os.homedir(), '.antigravity_cockpit');
}

export function getAntigravityStateDbPath(): string {
    if (isAntigravityWslRemote()) {
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
