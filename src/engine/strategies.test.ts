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

        it('should identify a valid Antigravity process with hub-port format', () => {
            const cmd = 'C:\\Path\\to\\agy.exe --hub --hub-port=53125 --csrf_token=abc-123 --app_data_dir=antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should reject process missing extension_server_port and hub-port', () => {
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

        it('should identify a valid Antigravity agy process with hub-port on Unix', () => {
            const cmd = '/path/to/agy --hub --hub-port=53125 --app_data_dir=antigravity --csrf_token=abc-123';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should handle different space/equals formats', () => {
            const cmd = '/path/to/language_server --extension_server_port 53125 --csrf_token abc-123 --app_data_dir antigravity';
            expect(isAntigravityProcess(cmd)).toBe(true);
        });

        it('should reject invalid app_data_dir', () => {
            const cmd = '/path/to/language_server --extension_server_port 53125 --csrf_token abc-123 --app_data_dir=wrong';
            expect(isAntigravityProcess(cmd)).toBe(false);
        });
    });
});
