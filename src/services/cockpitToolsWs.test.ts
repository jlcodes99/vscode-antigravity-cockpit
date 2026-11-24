import {
    CockpitToolsWsClient,
    isObjectPayload,
    parsePluginSwitchAccountPayload,
} from './cockpitToolsWs';

describe('WS connection error handling', () => {
    let originalWebSocket: unknown;

    beforeEach(() => {
        originalWebSocket = global.WebSocket;
    });

    afterEach(() => {
        global.WebSocket = originalWebSocket as typeof WebSocket;
        jest.useRealTimers();
    });

    it('初始握手失败触发 onerror 时应调度重连，且后续 onclose 不重复递增计数', () => {
        jest.useFakeTimers();

        type MockWsInstance = {
            onopen: (() => void) | null;
            onclose: ((event: { code: number }) => void) | null;
            onerror: ((error: unknown) => void) | null;
            onmessage: ((event: { data: string }) => void) | null;
            close: jest.Mock;
        };

        let capturedWs: MockWsInstance | null = null;
        const MockWebSocket = jest.fn().mockImplementation(() => {
            capturedWs = {
                onopen: null,
                onclose: null,
                onerror: null,
                onmessage: null,
                close: jest.fn(),
            };
            return capturedWs;
        });

        // @ts-expect-error Mocking WebSocket
        global.WebSocket = MockWebSocket;

        const client = new CockpitToolsWsClient();
        // 调用私有 doConnect
        (client as unknown as { doConnect: () => void }).doConnect();

        expect(capturedWs).not.toBeNull();
        const ws = capturedWs as unknown as MockWsInstance;

        // 模拟 WHATWG WebSocket 仅触发 onerror
        ws.onerror?.(new Error('Connection refused'));

        const clientPrivates = client as unknown as {
            reconnectFailCount: number;
            reconnectTimer: NodeJS.Timeout | null;
            cleanup: () => void;
        };

        expect(clientPrivates.reconnectFailCount).toBe(1);
        expect(clientPrivates.reconnectTimer).not.toBeNull();

        // 模拟紧随其后的 onclose，计数不应被二次递增
        ws.onclose?.({ code: 1006 });
        expect(clientPrivates.reconnectFailCount).toBe(1);

        clientPrivates.cleanup();
    });
});

describe('WS inbound payload guards', () => {
    describe('isObjectPayload', () => {
        it('接受普通对象', () => {
            expect(isObjectPayload({ a: 1 })).toBe(true);
        });
        it('拒绝 null / 数组 / 原始类型', () => {
            expect(isObjectPayload(null)).toBe(false);
            expect(isObjectPayload([1, 2])).toBe(false);
            expect(isObjectPayload('x')).toBe(false);
            expect(isObjectPayload(42)).toBe(false);
            expect(isObjectPayload(undefined)).toBe(false);
        });
    });

    describe('parsePluginSwitchAccountPayload', () => {
        it('合法 payload 通过', () => {
            const payload = { target_email: 'a@example.com', switch_mode: 'seamless' };
            expect(parsePluginSwitchAccountPayload(payload)?.target_email).toBe('a@example.com');
        });

        it('空 target_email 被拒绝（防止落到切号执行层）', () => {
            expect(parsePluginSwitchAccountPayload({ target_email: '' })).toBeNull();
        });

        it('target_email 非字符串被拒绝', () => {
            expect(parsePluginSwitchAccountPayload({ target_email: 123 })).toBeNull();
            expect(parsePluginSwitchAccountPayload({ target_email: ['a@b.c'] })).toBeNull();
        });

        it('非对象/数组/null 被拒绝', () => {
            expect(parsePluginSwitchAccountPayload(null)).toBeNull();
            expect(parsePluginSwitchAccountPayload(undefined)).toBeNull();
            expect(parsePluginSwitchAccountPayload('evil')).toBeNull();
            expect(parsePluginSwitchAccountPayload([{ target_email: 'a@b.c' }])).toBeNull();
        });
    });
});
