import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getServerDataPath, SERVER_RUNTIME_FILES } from '../../lib/config/paths';
import { LocalFilesystem } from '../../lib/core/local-filesystem';

// The per-home half of the data epoch is one small JSON file in data/server/, read once per process. A stream announces
// it on every keepalive, so a file that no longer parses must cost a reload, never every stream and collab open.

const file = getServerDataPath(SERVER_RUNTIME_FILES.homeEpochs);
const original = existsSync(file) ? readFileSync(file) : null;
let loads = 0;

// A process start: the module reads the file anew. The query makes bun evaluate it anew.
async function startProcess(): Promise<typeof import('../../lib/home/data-epoch')> {
    loads += 1;
    return await import(`../../lib/home/data-epoch?load=${loads}`);
}

afterEach(() => {
    if (original) writeFileSync(file, original);
    else rmSync(file, { force: true });
});

describe('Data epoch', () => {
    test('a torn epochs file reads as no restores yet, and the next rotation writes it whole again', async () => {
        writeFileSync(file, '{"user_a":"half');
        const { getDataEpoch, rotateHomeDataEpoch } = await startProcess();
        const serverEpoch = getDataEpoch('a home never restored');
        expect(getDataEpoch('user_a')).toBe(serverEpoch);

        await rotateHomeDataEpoch('user_a');
        expect(serverEpoch + JSON.parse(readFileSync(file, 'utf8')).user_a).toBe(getDataEpoch('user_a'));
    });

    test('a rotation replaces the file whole, so a reader never meets half of it', async () => {
        const { rotateHomeDataEpoch } = await startProcess();
        const writeAtomic = spyOn(LocalFilesystem.prototype, 'writeAtomic');
        try {
            await rotateHomeDataEpoch('user_a');
            expect(writeAtomic).toHaveBeenCalledWith(SERVER_RUNTIME_FILES.homeEpochs, expect.any(String));
        } finally {
            writeAtomic.mockRestore();
        }
    });

    test('two restores finishing together both land in the file', async () => {
        rmSync(file, { force: true });
        const { getDataEpoch, rotateHomeDataEpoch } = await startProcess();
        await Promise.all([rotateHomeDataEpoch('user_a'), rotateHomeDataEpoch('user_b')]);
        const { getDataEpoch: afterRestart } = await startProcess();
        expect(afterRestart('user_a')).toBe(getDataEpoch('user_a'));
        expect(afterRestart('user_b')).toBe(getDataEpoch('user_b'));
    });
});
