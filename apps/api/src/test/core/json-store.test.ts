import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonStore, LocalFilesystem } from '../../lib/core';
import { TEST_DATA_DIR } from '../setup';

const TEST_DIR = join(TEST_DATA_DIR, 'json-store');

type TestConfig = {
    name: string;
    count: number;
    nested: {
        enabled: boolean;
        tags: string[];
        deep: {
            value: number;
        };
    };
};

const defaults: TestConfig = {
    name: 'default',
    count: 0,
    nested: {
        enabled: true,
        tags: [],
        deep: {
            value: 42,
        },
    },
};

function createStore(subdir: string) {
    const dir = join(TEST_DIR, subdir);
    mkdirSync(dir, { recursive: true });
    const fs = new LocalFilesystem(dir);
    return { fs, store: new JsonStore<TestConfig>(fs, 'config.json', defaults) };
}

describe('JsonStore', () => {
    test('returns defaults before load when file does not exist', () => {
        const { store } = createStore('no-file');
        expect(store.get()).toEqual(defaults);
    });

    test('load returns defaults when file does not exist', async () => {
        const { store } = createStore('load-missing');
        await store.load();
        expect(store.get()).toEqual(defaults);
    });

    test('set writes and persists data', async () => {
        const { store } = createStore('set-basic');
        await store.load();
        await store.set({ name: 'updated' });
        expect(store.get().name).toBe('updated');
        expect(store.get().count).toBe(0);

        // Verify persisted to disk
        const raw = JSON.parse(readFileSync(join(TEST_DIR, 'set-basic', 'config.json'), 'utf-8'));
        expect(raw.name).toBe('updated');
        expect(raw.count).toBe(0);
    });

    test('set deep-merges nested objects', async () => {
        const { store } = createStore('deep-merge');
        await store.load();

        await store.set({ nested: { enabled: false } });
        const result = store.get();
        expect(result.nested.enabled).toBe(false);
        expect(result.nested.deep.value).toBe(42);
        expect(result.nested.tags).toEqual([]);
    });

    test('set replaces arrays (no merge)', async () => {
        const { store } = createStore('array-replace');
        await store.load();

        await store.set({ nested: { tags: ['a', 'b'] } });
        expect(store.get().nested.tags).toEqual(['a', 'b']);

        await store.set({ nested: { tags: ['c'] } });
        expect(store.get().nested.tags).toEqual(['c']);
    });

    test('set deep-merges deeply nested objects', async () => {
        const { store } = createStore('deep-nested');
        await store.load();

        await store.set({ nested: { deep: { value: 99 } } });
        expect(store.get().nested.deep.value).toBe(99);
        expect(store.get().nested.enabled).toBe(true);
    });

    test('load reads existing file and merges with defaults', async () => {
        const dir = join(TEST_DIR, 'load-existing');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'from-disk', extra: 'ignored' }));

        const fs = new LocalFilesystem(dir);
        const store = new JsonStore<TestConfig>(fs, 'config.json', defaults);
        await store.load();

        expect(store.get().name).toBe('from-disk');
        expect(store.get().count).toBe(0);
        expect(store.get().nested.deep.value).toBe(42);
    });

    test('load fails closed on a corrupt existing file instead of resetting to defaults', async () => {
        const dir = join(TEST_DIR, 'corrupt');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'config.json'), '{invalid json!!!');

        const fs = new LocalFilesystem(dir);
        const store = new JsonStore<TestConfig>(fs, 'config.json', defaults);

        // A corrupt/half-written existing file is unrecoverable in place, not a fresh install: it
        // must reject rather than silently reset to defaults (which the next set() would persist).
        await expect(store.load()).rejects.toThrow();
    });

    test('a failed load never lets a later set() overwrite the existing file with defaults', async () => {
        const dir = join(TEST_DIR, 'corrupt-no-wipe');
        mkdirSync(dir, { recursive: true });
        const original = '{invalid json!!!';
        writeFileSync(join(dir, 'config.json'), original);

        const fs = new LocalFilesystem(dir);
        const store = new JsonStore<TestConfig>(fs, 'config.json', defaults);

        // Mirror the real caller flow (e.g. UserHome.init): await load(), then mutate. A rejected
        // load must abort before set(), so the recoverable bytes on disk survive untouched.
        let loadThrew = false;
        try {
            await store.load();
            await store.set({ name: 'toggled' });
        } catch {
            loadThrew = true;
        }

        expect(loadThrew).toBe(true);
        expect(readFileSync(join(dir, 'config.json'), 'utf-8')).toBe(original);
    });

    test('atomic write: no .tmp file left after save', async () => {
        const { store, fs } = createStore('atomic');
        await store.load();
        await store.set({ name: 'atomic-test' });

        expect(await fs.file('config.json').exists()).toBe(true);
        expect(await fs.file('config.json.tmp').exists()).toBe(false);
    });

    test('multiple sets accumulate changes', async () => {
        const { store } = createStore('multi-set');
        await store.load();

        await store.set({ name: 'first' });
        await store.set({ count: 5 });
        await store.set({ nested: { enabled: false } });

        const result = store.get();
        expect(result.name).toBe('first');
        expect(result.count).toBe(5);
        expect(result.nested.enabled).toBe(false);
        expect(result.nested.deep.value).toBe(42);
    });

    test('second instance reads what first instance wrote', async () => {
        const dir = join(TEST_DIR, 'two-instances');
        mkdirSync(dir, { recursive: true });
        const fs = new LocalFilesystem(dir);

        const store1 = new JsonStore<TestConfig>(fs, 'config.json', defaults);
        await store1.load();
        await store1.set({ name: 'written-by-1', nested: { deep: { value: 7 } } });

        const store2 = new JsonStore<TestConfig>(fs, 'config.json', defaults);
        await store2.load();
        expect(store2.get().name).toBe('written-by-1');
        expect(store2.get().nested.deep.value).toBe(7);
        expect(store2.get().nested.enabled).toBe(true);
    });
});
