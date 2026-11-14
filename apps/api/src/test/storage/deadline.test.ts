import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTempWithHash } from '../../lib/storage/deadline';
import { countLoopTurns, TEST_DATA_DIR } from '../setup';

const dir = mkdtempSync(join(TEST_DATA_DIR, 'deadline-'));
const SIZE = 8 * 1024 * 1024;
// Just written, so in the page cache: every read resolves at once, the case that never leaves the microtasks.
const source = join(dir, 'source.bin');
writeFileSync(source, Buffer.alloc(SIZE, 7));

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('consumeStream', () => {
    test('a copy of a local file gives the event loop a turn every 2 MB', async () => {
        const turns = countLoopTurns();
        try {
            const { size } = await writeTempWithHash(join(dir, crypto.randomUUID()), Bun.file(source));
            expect(size).toBe(SIZE);
        } finally {
            turns.stop();
        }
        expect(turns.read()).toBeGreaterThanOrEqual(3);
    });
});
