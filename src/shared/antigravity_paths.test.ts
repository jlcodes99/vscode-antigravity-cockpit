import * as path from 'path';
import * as childProcess from 'child_process';
import {
    getAntigravityStateDbPath,
    setAntigravityRemoteName,
    setAntigravityUserDataDir,
} from './antigravity_paths';

jest.mock('child_process', () => ({
    execFileSync: jest.fn(),
}));

describe('antigravity_paths', () => {
    afterEach(() => {
        jest.clearAllMocks();
        setAntigravityRemoteName(null);
        setAntigravityUserDataDir(null);
    });

    it('should resolve Windows AppData state.vscdb when running in WSL', () => {
        const execFileSyncMock = childProcess.execFileSync as jest.MockedFunction<typeof childProcess.execFileSync>;
        execFileSyncMock
            .mockImplementationOnce(() => 'C:\\Users\\Alice\\AppData\\Roaming\r\n' as never)
            .mockImplementationOnce(() => '/mnt/c/Users/Alice/AppData/Roaming\n' as never);

        setAntigravityRemoteName('wsl');
        setAntigravityUserDataDir('/home/alice/.vscode-server/data');

        expect(getAntigravityStateDbPath()).toBe(
            '/mnt/c/Users/Alice/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb',
        );
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        expect(execFileSyncMock).toHaveBeenNthCalledWith(
            1,
            'cmd.exe',
            ['/d', '/u', '/c', 'echo', '%APPDATA%'],
            expect.objectContaining({ encoding: 'utf16le' }),
        );
    });

    it('should preserve non-ASCII Windows profile names when running in WSL', () => {
        const execFileSyncMock = childProcess.execFileSync as jest.MockedFunction<typeof childProcess.execFileSync>;
        execFileSyncMock
            .mockImplementationOnce(() => 'C:\\Users\\李杰\\AppData\\Roaming\r\n' as never)
            .mockImplementationOnce(() => '/mnt/c/Users/李杰/AppData/Roaming\n' as never);

        setAntigravityRemoteName('wsl');

        expect(getAntigravityStateDbPath()).toBe(
            '/mnt/c/Users/李杰/AppData/Roaming/Antigravity/User/globalStorage/state.vscdb',
        );
    });

    it('should keep using the current instance path outside WSL', () => {
        setAntigravityRemoteName(null);
        setAntigravityUserDataDir('/home/alice/.vscode-server/data');

        expect(getAntigravityStateDbPath()).toBe(
            path.join('/home/alice/.vscode-server/data', 'User', 'globalStorage', 'state.vscdb'),
        );
    });
});
