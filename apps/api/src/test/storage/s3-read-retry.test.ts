import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    RETRY_WAITS_MS,
    readStorageFile,
    STORAGE_TIMEOUT_MS,
    setRetryWaitsMs,
    setStorageTimeoutMs,
    streamStorageFile,
} from '../../lib/storage/deadline';
import { LocalStorage } from '../../lib/storage/local-storage';
import { S3Storage } from '../../lib/storage/s3-storage';
import { FakeS3Server } from '../fake-s3-server';
import { SHRUNK_RETRY_WAITS_MS, STALL_BOUND_MS, waitFor } from '../fault-storage-helpers';

// The real S3Storage against a fake S3 that answers 503 SlowDown, as Hetzner does under load. Bun's S3Client never
// retries a read itself.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-s3-read-retry-${Date.now()}`);
const BYTES = new Uint8Array(4096).fill(7);
// Longer than the first wait (200 to 300 ms), shorter than the first two together.
const RETRY_DEADLINE_MS = 500;

let fake: FakeS3Server;
let storage: S3Storage;
let key: string;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
beforeEach(async () => {
    fake = new FakeS3Server(new LocalStorage(join(TEST_DIR, `bucket-${Math.random().toString(36).slice(2)}`)));
    storage = new S3Storage(await fake.start());
    await storage.write('image.png', BYTES);
    key = storage.getKey('image.png');
});
afterEach(async () => {
    setStorageTimeoutMs(STORAGE_TIMEOUT_MS);
    fake.heal();
    await fake.stop();
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('S3 reads retry a throttled answer', () => {
    test.each([
        ['a HEAD', 'finds the object', () => storage.exists('image.png'), true, () => fake.heads.get(key)],
        ['a stat', 'reads the size', () => storage.size('image.png'), BYTES.length, () => fake.heads.get(key)],
        [
            'a GET',
            'reads the whole body',
            async () => new Uint8Array(await readStorageFile(storage.read('image.png'))),
            BYTES,
            () => fake.gets.get(key),
        ],
    ])('%s answered 503 SlowDown once %s on the next attempt', async (_request, _outcome, read, expected, requests) => {
        fake.slowDowns.set(key, 1);
        expect(await read()).toEqual(expected);
        expect(requests()).toBe(2);
    });

    test.each([
        ['HEADs', () => storage.exists('image.png'), () => fake.heads.get(key)],
        ['stats', () => storage.size('image.png'), () => fake.heads.get(key)],
        ['GETs', () => readStorageFile(storage.read('image.png')), () => fake.gets.get(key)],
    ])(
        'three SlowDowns in a row answer 503 Storage unavailable after exactly three %s',
        async (_requests, read, requests) => {
            fake.slowDowns.set(key, 3);
            await expect(read()).rejects.toMatchObject({ status: 503, message: 'Storage unavailable' });
            expect(requests()).toBe(3);
        },
    );
});

describe('S3 reads do not retry a definite answer', () => {
    test('a missing object is one HEAD per probe', async () => {
        expect(await storage.exists('missing.png')).toBe(false);
        expect(await storage.size('missing.png')).toBeNull();
        expect(fake.heads.get(storage.getKey('missing.png'))).toBe(2);
    });

    test('a missing object is one GET', async () => {
        await expect(readStorageFile(storage.read('missing.png'))).rejects.toMatchObject({ status: 503 });
        expect(fake.gets.get(storage.getKey('missing.png'))).toBe(1);
    });

    test('a refused GET is one GET', async () => {
        fake.faults.set(key, 'deny');
        await expect(readStorageFile(storage.read('image.png'))).rejects.toMatchObject({ status: 503 });
        expect(fake.gets.get(key)).toBe(1);
    });

    // A second GET would hand the chunk handler the first half again. Big enough that a chunk arrives before the cut.
    test('a GET cut off after its first bytes is one GET', async () => {
        await storage.write('big.bin', new Uint8Array(1024 * 1024).fill(7));
        const bigKey = storage.getKey('big.bin');
        fake.faults.set(bigKey, 'cut');
        let received = 0;
        const read = streamStorageFile(storage.read('big.bin'), (chunk) => {
            received += chunk.byteLength;
        });
        await expect(read).rejects.toMatchObject({ status: 503 });
        expect(received).toBeGreaterThan(0);
        expect(fake.gets.get(bigKey)).toBe(1);
    });
});

// Real waits: these pin where a wait falls against the deadline and the signal.
describe('a retry stays inside the storage deadline', () => {
    beforeEach(() => setRetryWaitsMs(RETRY_WAITS_MS));
    afterEach(() => setRetryWaitsMs(SHRUNK_RETRY_WAITS_MS));

    test('a HEAD stops retrying when the deadline fires during its wait', async () => {
        setStorageTimeoutMs(RETRY_DEADLINE_MS);
        fake.slowDowns.set(key, 3);
        const started = Date.now();
        await expect(storage.exists('image.png')).rejects.toMatchObject({ status: 503 });
        expect(Date.now() - started).toBeLessThan(RETRY_DEADLINE_MS + STALL_BOUND_MS);
        // Past where a third attempt would have run without the deadline: 300 ms, then at most 1200 ms.
        await Bun.sleep(1_600);
        expect(fake.heads.get(key)).toBe(2);
    });

    test("a GET stops retrying when its read's signal aborts during the wait", async () => {
        fake.slowDowns.set(key, 3);
        const controller = new AbortController();
        const read = readStorageFile(storage.read('image.png'), { signal: controller.signal });
        read.catch(() => {});
        await waitFor(() => fake.gets.get(key) === 1);
        // The SlowDown answers at once; the first wait is at least 200 ms.
        await Bun.sleep(50);
        controller.abort();
        const started = Date.now();
        await expect(read).rejects.toMatchObject({ status: 503 });
        expect(Date.now() - started).toBeLessThan(STALL_BOUND_MS);
        await Bun.sleep(1_600);
        expect(fake.gets.get(key)).toBe(1);
    });
});
