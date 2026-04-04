import * as vscode from 'vscode';
import { logger } from './log_service';

const COCKPIT_TOOLS_DEEP_LINK = 'cockpit-tools://';

function getLaunchCommand(): string {
    if (process.platform === 'darwin') {
        return 'open -a "Cockpit Tools"';
    }
    if (process.platform === 'win32') {
        return 'start "" "Cockpit Tools"';
    }
    return 'cockpit-tools';
}

function isWindowsNotFoundError(message: string): boolean {
    const normalized = message.toLowerCase();
    return [
        'not found',
        'cannot find',
        'is not recognized as an internal or external command',
        '不是内部或外部命令',
        '找不到',
        '見つかりません',
    ].some((keyword) => normalized.includes(keyword));
}

async function launchByCommand(command: string): Promise<{ opened: boolean; errorMessage?: string }> {
    try {
        const { exec } = await import('child_process');
        return await new Promise((resolve) => {
            exec(command, (error, _stdout, stderr) => {
                if (!error) {
                    resolve({ opened: true });
                    return;
                }
                const detail = [error.message, stderr].filter(Boolean).join('\n').trim();
                resolve({
                    opened: false,
                    errorMessage: detail || error.message,
                });
            });
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            opened: false,
            errorMessage: message,
        };
    }
}

async function launchByDeepLink(sourceTag: string): Promise<boolean> {
    try {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(COCKPIT_TOOLS_DEEP_LINK));
        if (!opened) {
            logger.warn(`[${sourceTag}] Failed to open Cockpit Tools by deep link`);
        }
        return opened;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[${sourceTag}] Failed to open Cockpit Tools by deep link: ${message}`);
        return false;
    }
}

export async function openCockpitToolsDesktop(sourceTag: string): Promise<boolean> {
    const command = getLaunchCommand();
    const result = await launchByCommand(command);
    if (result.opened) {
        return true;
    }

    const errorMessage = result.errorMessage ?? '';
    if (process.platform === 'win32' && isWindowsNotFoundError(errorMessage)) {
        logger.warn(
            `[${sourceTag}] Cockpit Tools command not found, trying deep link fallback: ${errorMessage}`,
        );
        return launchByDeepLink(sourceTag);
    }

    if (errorMessage) {
        logger.warn(`[${sourceTag}] Failed to open Cockpit Tools: ${errorMessage}`);
    } else {
        logger.warn(`[${sourceTag}] Failed to open Cockpit Tools`);
    }
    return false;
}
