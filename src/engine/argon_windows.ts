/**
 * Argon 窗口判定（共享给 reactor 内多处使用的纯函数）。
 */

export function isArgonWeeklyBucketId(id: string): boolean {
    return id === 'argon-weekly' || /^gemini-argon-(?:.+-)?weekly$/.test(id);
}

export function isArgonShortBucketId(id: string): boolean {
    return id === 'argon-5h' || /^gemini-argon-(?:.+-)?5h$/.test(id);
}

/** Argon 组官方窗口（官方桶 ID 命名或官方组名）——这些窗口保留官方周期命名 */
export function isArgonWindowLike(input: { windowId?: string; windowName?: string }): boolean {
    const id = input.windowId || '';
    const name = (input.windowName || '').toLowerCase();
    return isArgonWeeklyBucketId(id) || isArgonShortBucketId(id) || /argon/i.test(name);
}
