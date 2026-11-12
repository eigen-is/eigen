import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalStorage } from '../../lib/storage/local-storage';
import { S3Storage } from '../../lib/storage/s3-storage';

const TEST_DIR = join(import.meta.dir, `../../../../../data/test-storage-${Date.now()}`);

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('LocalStorage', () => {
    let storage: LocalStorage;

    beforeAll(() => {
        storage = new LocalStorage(join(TEST_DIR, 'local-storage'));
    });

    test('write and read file', async () => {
        const data = Buffer.from('local content');
        await storage.write('doc.txt', data);
        const file = storage.read('doc.txt');
        expect(await file.exists()).toBe(true);
        const content = await file.text();
        expect(content).toBe('local content');
    });

    test('write and read nested file', async () => {
        await storage.mkdir('subfolder');
        const data = Buffer.from('nested content');
        await storage.write('subfolder/nested.txt', data);
        expect(await storage.exists('subfolder/nested.txt')).toBe(true);
        const file = storage.read('subfolder/nested.txt');
        expect(await file.text()).toBe('nested content');
    });

    test('mkdir creates directory', async () => {
        await storage.mkdir('new-dir');
        await storage.mkdir('new-dir/sub');
        const data = Buffer.from('deep file');
        await storage.write('new-dir/sub/file.txt', data);
        expect(await storage.exists('new-dir/sub/file.txt')).toBe(true);
    });

    test('rename moves file', async () => {
        await storage.write('old-name.txt', Buffer.from('rename me'));
        await storage.rename('old-name.txt', 'new-name.txt');
        expect(await storage.exists('old-name.txt')).toBe(false);
        expect(await storage.exists('new-name.txt')).toBe(true);
        const file = storage.read('new-name.txt');
        expect(await file.text()).toBe('rename me');
    });

    test('rename creates parent directories', async () => {
        await storage.write('flat-file.txt', Buffer.from('will be nested'));
        await storage.rename('flat-file.txt', 'deep/nested/moved.txt');
        expect(await storage.exists('flat-file.txt')).toBe(false);
        expect(await storage.exists('deep/nested/moved.txt')).toBe(true);
    });

    test('deleteDir removes directory tree', async () => {
        await storage.mkdir('tree');
        await storage.write('tree/a.txt', Buffer.from('a'));
        await storage.mkdir('tree/sub');
        await storage.write('tree/sub/b.txt', Buffer.from('b'));
        const deleted = await storage.deleteDir('tree');
        expect(deleted).toBe(true);
        expect(await storage.exists('tree/a.txt')).toBe(false);
        expect(await storage.exists('tree/sub/b.txt')).toBe(false);
    });

    test('deleteDir answers true for a missing directory, as delete does for a missing key', async () => {
        expect(await storage.deleteDir('nonexistent-dir')).toBe(true);
    });

    test('path traversal with .. is rejected', () => {
        expect(() => storage.read('../etc/passwd')).toThrow('path traversal');
    });

    test('path traversal with nested .. is rejected', () => {
        expect(() => storage.read('subfolder/../../etc/passwd')).toThrow('path traversal');
    });

    test('path traversal via resolve is rejected', () => {
        expect(() => storage.getPath('../../secret')).toThrow('path traversal');
    });

    test('valid nested paths are allowed', () => {
        expect(() => storage.read('folder/sub/file.txt')).not.toThrow();
    });

    test('getPath returns correct path', () => {
        const p = storage.getPath('my-key');
        expect(p).toContain('my-key');
        expect(p).toContain('data');
    });

    // Same contract as S3Storage: true once the key is gone, false only for a failed call.
    test('delete returns true for a missing file', async () => {
        expect(await storage.delete('nonexistent')).toBe(true);
    });

    test('size returns correct value', async () => {
        await storage.write('sized.txt', Buffer.from('12345'));
        const size = await storage.size('sized.txt');
        expect(size).toBe(5);
    });

    test('size returns null for missing file', async () => {
        const size = await storage.size('no-such-file');
        expect(size).toBeNull();
    });
});

describe('LocalStorage.write lands a file whole', () => {
    const SIZE = 8 * 1024 * 1024;
    const base = join(TEST_DIR, 'local-write');
    const sourceDir = join(TEST_DIR, 'local-write-source');
    const old = Buffer.alloc(SIZE, 1);
    let storage: LocalStorage;

    beforeAll(() => {
        storage = new LocalStorage(base);
        mkdirSync(sourceDir, { recursive: true });
    });

    const tmpEntries = () => (existsSync(join(base, 'tmp')) ? readdirSync(join(base, 'tmp')) : []);
    const dataEntries = () => readdirSync(join(base, 'data'), { recursive: true }).map(String).sort();

    // A shorter and a longer new file, from memory and from a file on disk as an upload hands it over.
    const overwrites = [
        { name: 'shorter bytes', next: Buffer.alloc(SIZE / 2, 2), asFile: false },
        { name: 'longer bytes', next: Buffer.alloc(SIZE * 1.5, 2), asFile: false },
        { name: 'a shorter file', next: Buffer.alloc(SIZE / 2, 2), asFile: true },
        { name: 'a longer file', next: Buffer.alloc(SIZE * 1.5, 2), asFile: true },
    ];

    async function sourceOf(next: Buffer, asFile: boolean) {
        if (!asFile) return next;
        const sourcePath = join(sourceDir, crypto.randomUUID());
        writeFileSync(sourcePath, next);
        return Bun.file(sourcePath);
    }

    for (const { name, next, asFile } of overwrites) {
        test(`a reader that opened the key before an overwrite with ${name} reads the old file`, async () => {
            const key = `opened-${crypto.randomUUID()}.bin`;
            await storage.write(key, old);
            const reader = storage.read(key).stream().getReader();
            const chunks: Uint8Array[] = [];
            const first = await reader.read();
            if (first.value) chunks.push(first.value);
            expect(Buffer.concat(chunks).byteLength).toBeLessThan(SIZE);

            expect(await storage.write(key, await sourceOf(next, asFile))).toBe(next.byteLength);

            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) chunks.push(chunk.value);
            expect(Buffer.concat(chunks).equals(old)).toBe(true);
            expect(Buffer.from(await storage.read(key).arrayBuffer()).equals(next)).toBe(true);
        });

        test(`a read beside an overwrite with ${name} gets the old file or the new one`, async () => {
            const key = `beside-${crypto.randomUUID()}.bin`;
            await storage.write(key, old);
            const source = await sourceOf(next, asFile);
            for (let round = 0; round < 5; round++) {
                const write = storage.write(key, round % 2 === 0 ? source : old);
                const reads = await Promise.all(
                    [0, 1, 2, 3].map(async (turns) => {
                        for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
                        return Buffer.from(await storage.read(key).arrayBuffer());
                    }),
                );
                await write;
                for (const read of reads) expect(read.equals(old) || read.equals(next)).toBe(true);
            }
        });
    }

    test('the bytes go to a side file in tmp/, so a killed write leaves no half file at the key', async () => {
        const key = 'side.bin';
        await storage.write(key, old);
        const next = Buffer.alloc(SIZE / 2, 2);
        // What is on disk once every byte is written, right before the one step that changes the key.
        const seen: { from: string; side: Buffer; atKey: Buffer }[] = [];
        const rename = fsPromises.rename;
        const spy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
            seen.push({
                from: String(from),
                side: readFileSync(join(base, 'tmp', tmpEntries()[0] ?? '')),
                atKey: readFileSync(join(base, 'data', key)),
            });
            return rename(from, to);
        });
        try {
            await storage.write(key, next);
        } finally {
            spy.mockRestore();
        }
        expect(seen.length).toBe(1);
        expect(dirname(seen[0]?.from ?? '')).toBe(join(base, 'tmp'));
        expect(seen[0]?.side.equals(next)).toBe(true);
        expect(seen[0]?.atKey.equals(old)).toBe(true);
    });

    test('a missing parent folder is created', async () => {
        await storage.write('not/there/yet.txt', Buffer.from('made'));
        expect(readFileSync(join(base, 'data/not/there/yet.txt'), 'utf8')).toBe('made');
    });

    test('a failed write leaves the old file, and no side file in data/ or tmp/', async () => {
        const key = 'kept.bin';
        await storage.write(key, old);
        const before = dataEntries();
        await expect(storage.write(key, Bun.file(join(sourceDir, 'no-such-source')))).rejects.toThrow();
        // A key whose parent is a file can take no rename.
        await expect(storage.write(`${key}/below.bin`, Buffer.from('never'))).rejects.toThrow();
        expect(readFileSync(join(base, 'data', key)).equals(old)).toBe(true);
        expect(dataEntries()).toEqual(before);
        expect(tmpEntries()).toEqual([]);
    });

    test('nothing stays in tmp/ after a write', async () => {
        await storage.write('tidy.txt', Buffer.from('tidy'));
        expect(existsSync(join(base, 'tmp'))).toBe(true);
        expect(tmpEntries()).toEqual([]);
    });
});

// getKey validates synchronously before any network call, so these run without a live S3.
// The network-touching surface (read/write/stat round-trips) needs the MinIO-gated suite.
describe('S3Storage key guard', () => {
    let storage: S3Storage;

    beforeAll(() => {
        storage = new S3Storage({
            endpoint: 'http://localhost:9',
            bucket: 'test-bucket',
            prefix: 'prefix',
            accessKeyId: 'key',
            secretAccessKey: 'secret',
        });
    });

    test('path traversal with .. is rejected', () => {
        expect(() => storage.read('a/../b')).toThrow('path traversal');
    });

    test('empty segments (leading/trailing/double slash) are rejected with 400', () => {
        // An empty segment builds `prefix//x` — S3 rejects it as an opaque XMinioInvalidObjectName 500.
        for (const key of ['/x', 'a//b', 'x/', '']) {
            expect(() => storage.read(key)).toThrow('empty path segment');
        }
    });

    test('valid nested keys are allowed', () => {
        expect(() => storage.read('a/b')).not.toThrow();
        expect(() => storage.read('folder-uuid/file-uuid')).not.toThrow();
    });

    test('a provider failure on exists surfaces as a 503, not a raw error', async () => {
        await expect(storage.exists('a/b')).rejects.toMatchObject({ status: 503 });
    });
});
