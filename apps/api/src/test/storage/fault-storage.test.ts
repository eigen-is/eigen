import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../../lib/core';
import { wrapWithStorageFault } from '../../lib/storage/fault-storage';
import { LocalStorage } from '../../lib/storage/local-storage';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-fault-storage-${Date.now()}`);

let storage: LocalStorage;

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    storage = new LocalStorage(TEST_DIR);
});

afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
    delete process.env['EIGEN_STORAGE_FAULT'];
    delete process.env['PRODUCTION'];
});

describe('wrapWithStorageFault', () => {
    test('returns the backend untouched when the flag is unset', () => {
        expect(wrapWithStorageFault(storage)).toBe(storage);
    });

    test('exists-throw rejects with a 503', async () => {
        process.env['EIGEN_STORAGE_FAULT'] = 'exists-throw';
        const wrapped = wrapWithStorageFault(storage);
        const error = await wrapped.exists('missing.txt').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(ApiError);
        if (!(error instanceof ApiError)) throw error;
        expect(error.status).toBe(503);
    });

    test('exists-delay stalls the existence probe', async () => {
        process.env['EIGEN_STORAGE_FAULT'] = 'exists-delay=50';
        const wrapped = wrapWithStorageFault(storage);
        await storage.write('delayed.txt', Buffer.from('hi'));
        const start = Bun.nanoseconds();
        expect(await wrapped.exists('delayed.txt')).toBe(true);
        expect((Bun.nanoseconds() - start) / 1_000_000).toBeGreaterThanOrEqual(50);
    });

    test('stays inert in production', () => {
        process.env['EIGEN_STORAGE_FAULT'] = 'exists-throw';
        process.env['PRODUCTION'] = '1';
        expect(wrapWithStorageFault(storage)).toBe(storage);
    });
});
