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

async function turnsDuringCopy(yields?: boolean): Promise<number> {
    const turns = countLoopTurns();
    try {
        const { size } = await writeTempWithHash(join(dir, crypto.randomUUID()), Bun.file(source), { yields });
        expect(size).toBe(SIZE);
    } finally {
        turns.stop();
    }
    return turns.read();
}

describe('consumeStream', () => {
    test('a reader that passes yields gives the event loop a turn every 2 MB of a local file', async () => {
        expect(await turnsDuringCopy(true)).toBeGreaterThanOrEqual(3);
    });

    // The unlocked readers (Drive copy, readBytes, mail attachments) rely on this to keep an overwrite out.
    test('any other reader copies a warm local file in one step', async () => {
        expect(await turnsDuringCopy()).toBe(0);
    });
});
