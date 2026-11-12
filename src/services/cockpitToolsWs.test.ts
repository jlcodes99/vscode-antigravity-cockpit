import {
    isObjectPayload,
    parsePluginSwitchAccountPayload,
} from './cockpitToolsWs';

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
