import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTempWithHash } from '../../lib/storage/deadline';
import { TEST_DATA_DIR } from '../setup';

const dir = mkdtempSync(join(TEST_DATA_DIR, 'deadline-'));

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('consumeStream', () => {
    test('a large local file is copied without holding the event loop for its whole length', async () => {
        // Just written, so in the page cache: every read resolves at once, the case that never left the microtasks.
        const source = join(dir, 'source.bin');
        writeFileSync(source, Buffer.alloc(64 * 1024 * 1024, 7));
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        try {
            const { size } = await writeTempWithHash(join(dir, 'dest.bin'), Bun.file(source));
            expect(size).toBe(64 * 1024 * 1024);
        } finally {
            clearInterval(timer);
        }
        expect(ticks).toBeGreaterThan(0);
    });
});
