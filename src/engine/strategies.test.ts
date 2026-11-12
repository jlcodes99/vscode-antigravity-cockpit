import { WindowsStrategy, UnixStrategy } from './strategies';

describe('Process Detection Strategies', () => {
    describe('WindowsStrategy', () => {
        const strategy = new WindowsStrategy();
        
        // Access private method for testing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isAntigravityProcess = (strategy as any).isAntigravityProcess.bind(strategy);

        it('should identify a valid Antigravity process', () => {
            const cmd = 'C:\\Path\\to\\language_server.exe --extension_server_port 53125 --csrf_token abc-123 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should identify a valid agy hub process with equals syntax', () => {
            const cmd = 'C:\\Path\\to\\agy.exe --hub --hub-port=50308 --csrf_token=abc-123 --app_data_dir=antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should reject process missing extension_server_port', () => {
            const cmd = 'C:\\Path\\to\\language_server.exe --csrf_token abc-123 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(false);
        });

        it('should reject process missing csrf_token', () => {
            const cmd = 'C:\\Path\\to\\language_server.exe --extension_server_port 53125 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(false);
        });

        it('should reject process missing app_data_dir antigravity', () => {
            const cmd = 'C:\\Path\\to\\language_server.exe --extension_server_port 53125 --csrf_token abc-123 --app_data_dir something_else';
            expect(isAntigravityProcess(cmd)).toBe(false);
        });
    });

    describe('UnixStrategy', () => {
        const strategy = new UnixStrategy('darwin');
        
        // Access private method for testing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isAntigravityProcess = (strategy as any).isAntigravityProcess.bind(strategy);

        it('should identify a valid Antigravity process on Unix', () => {
            const cmd = '/path/to/language_server --extension_server_port=53125 --csrf_token=abc-123 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should handle different space/equals formats', () => {
            const cmd = '/path/to/language_server --extension_server_port 53125 --csrf_token abc-123 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should identify new agy hub process on Unix', () => {
            const cmd = '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/agy --hub --hub-port=50308 --csrf_token=849059ee-fa4d-4906-ac41-47cdbf962958 --app_data_dir=antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should reject invalid app_data_dir', () => {
            const cmd = '/path/to/language_server --extension_server_port 53125 --csrf_token abc-123 --app_data_dir=wrong';
            expect(isAntigravityProcess(cmd)).toBe(false);
        });

        it('should prioritize active non-orphan processes and newer PIDs over orphan processes (ppid=1)', () => {
            const stdout = [
                '11797     1 /Users/test/.gemini/bin/agy --hub --hub-port=50306 --app_data_dir=antigravity --csrf_token=token-old-orphan',
                '82598 82449 /Users/test/.gemini/bin/agy --hub --hub-port=56870 --app_data_dir=antigravity --csrf_token=token-active-1',
                '82910 82795 /Users/test/.gemini/bin/agy --hub --hub-port=57203 --app_data_dir=antigravity --csrf_token=token-active-2',
            ].join('\n');
            const parsed = strategy.parseProcessInfo(stdout);
            expect(parsed.map(p => p.pid)).toEqual([82910, 82598, 11797]);
        });
    });
});
