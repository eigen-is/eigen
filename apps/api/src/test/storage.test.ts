import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LocalKeyStorage } from '../lib/storage/local-key-storage';
import { LocalStorage } from '../lib/storage/local-storage';

const TEST_DIR = join(import.meta.dir, `../../../../data/test-storage-${Date.now()}`);

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('LocalKeyStorage', () => {
    let storage: LocalKeyStorage;

    beforeAll(() => {
        storage = new LocalKeyStorage(join(TEST_DIR, 'key-storage'));
    });

    test('write and read file', async () => {
        const data = Buffer.from('hello world');
        await storage.write('test-file', data);
        const file = storage.read('test-file');
        expect(await file.exists()).toBe(true);
        const content = await file.text();
        expect(content).toBe('hello world');
    });

    test('exists returns true for existing file', async () => {
        expect(await storage.exists('test-file')).toBe(true);
    });

    test('exists returns false for missing file', async () => {
        expect(await storage.exists('nonexistent')).toBe(false);
    });

    test('size returns correct size', async () => {
        const size = await storage.size('test-file');
        expect(size).toBe(11);
    });

    test('size returns null for missing file', async () => {
        const size = await storage.size('nonexistent');
        expect(size).toBeNull();
    });

    test('delete removes file', async () => {
        await storage.write('to-delete', Buffer.from('bye'));
        expect(await storage.exists('to-delete')).toBe(true);
        const deleted = await storage.delete('to-delete');
        expect(deleted).toBe(true);
        expect(await storage.exists('to-delete')).toBe(false);
    });

    test('delete returns false for missing file', async () => {
        const deleted = await storage.delete('nonexistent');
        expect(deleted).toBe(false);
    });

    test('getPath returns correct path', () => {
        const p = storage.getPath('my-key');
        expect(p).toContain('my-key');
        expect(p).toContain('data');
    });
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

    test('deleteDir returns false for missing directory', async () => {
        const deleted = await storage.deleteDir('nonexistent-dir');
        expect(deleted).toBe(false);
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

    test('delete returns false for missing file', async () => {
        const deleted = await storage.delete('nonexistent');
        expect(deleted).toBe(false);
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
