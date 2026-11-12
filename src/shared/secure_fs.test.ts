import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writePrivateFileAtomic, writePrivateFileSync } from './secure_fs';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-secure-fs-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('并发写同一缓存时文件完整且无临时文件残留', async () => {
    const file = path.join(root, 'cache', 'quota.json');
    await Promise.all(Array.from({ length: 12 }, (_, index) => writePrivateFileAtomic(file, JSON.stringify({ index, data: 'x'.repeat(10000) }))));
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(value.data).toHaveLength(10000);
    expect(await fs.readdir(path.dirname(file))).toEqual(['quota.json']);
});

test.each(['sync', 'async'])('%s 写入收紧已有文件和目录权限', async mode => {
    const directory = path.join(root, 'settings');
    const file = path.join(directory, 'settings.json');
    await fs.mkdir(directory, { mode: 0o755 });
    await fs.writeFile(file, 'old', { mode: 0o644 });
    if (mode === 'sync') {
        writePrivateFileSync(file, 'new');
    } else {
        await writePrivateFileAtomic(file, 'new');
    }
    expect(await fs.readFile(file, 'utf8')).toBe('new');
    if (process.platform !== 'win32') {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
});
