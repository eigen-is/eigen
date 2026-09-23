import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFilesystem } from '../../lib/core';

// Durability can only be proven by killing the machine, so what these pin is the protocol that buys it: the
// directory holding a name is fsynced after the operation that changed it, and a file system that refuses a
// directory fsync (NFS, CIFS, some FUSE mounts) never fails an operation that already happened.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-local-filesystem-${Date.now()}`);
let counter = 0;
const nextStore = () => new LocalFilesystem(join(TEST_DIR, `store-${counter++}`));
const SWEEP_AGE_MS = 60_000;
const backdate = (filePath: string) => {
    const past = new Date(Date.now() - 2 * SWEEP_AGE_MS);
    utimesSync(filePath, past, past);
};

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

// Records the directories an operation fsyncs, by the path the caller named them with.
const recordSyncs = async (store: LocalFilesystem, fn: () => Promise<void>): Promise<string[]> => {
    const synced: string[] = [];
    const spy = spyOn(store, 'syncDir').mockImplementation(async (dirPath: string) => {
        synced.push(dirPath);
    });
    try {
        await fn();
    } finally {
        spy.mockRestore();
    }
    return synced;
};

// The prototype every FileHandle shares, so a spy on it catches the fsync of a directory nothing else names.
async function syncProto(): Promise<{ sync: () => Promise<void> }> {
    const probe = await open(TEST_DIR, 'r');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    return proto;
}

describe('writeAtomic', () => {
    test('a failed write sweeps its own temp file and rethrows the original error', async () => {
        const store = nextStore();
        const base = join(TEST_DIR, `store-${counter - 1}`, 'cards');
        const proto = await syncProto();
        const spy = spyOn(proto, 'sync').mockImplementation(async () => {
            throw new Error('fsync failed');
        });

        try {
            await expect(store.writeAtomic('cards/doomed.vcf', 'doomed')).rejects.toThrow('fsync failed');
        } finally {
            spy.mockRestore();
        }

        // Only a process death leaves debris for sweepAtomicTemps: a write that fails on its own tidies up.
        expect(readdirSync(base)).toEqual([]);
    });
});

describe('sweepAtomicTemps', () => {
    test('removes only the dot-prefixed .tmp- leftovers writeAtomic stages', async () => {
        const store = nextStore();
        const base = join(TEST_DIR, `store-${counter - 1}`, 'cards');
        await store.mkdir('cards');
        writeFileSync(join(base, 'real.vcf'), 'x');
        writeFileSync(join(base, '.real.vcf.tmp-abc'), 'x');
        backdate(join(base, '.real.vcf.tmp-abc'));
        // A stray file is not temp debris — it survives and is warn-skipped by the domain's listing instead of
        // being silently deleted. A hand-placed dotfile without the `.tmp-` infix is not debris either.
        writeFileSync(join(base, 'stray.txt'), 'x');
        writeFileSync(join(base, '.backup.vcf'), 'x');
        backdate(join(base, 'stray.txt'));
        backdate(join(base, '.backup.vcf'));

        await store.sweepAtomicTemps('cards', SWEEP_AGE_MS);

        expect(readdirSync(base).sort()).toEqual(['.backup.vcf', 'real.vcf', 'stray.txt']);
    });

    test('a directory holding nothing but temp debris survives its own sweep', async () => {
        const store = nextStore();
        const base = join(TEST_DIR, `store-${counter - 1}`, 'cards');
        await store.mkdir('cards');
        writeFileSync(join(base, '.x.vcf.tmp-abc'), 'x');
        backdate(join(base, '.x.vcf.tmp-abc'));

        await store.sweepAtomicTemps('cards', SWEEP_AGE_MS);

        // Emptying the directory must not take it with it: the very same init enumerates it next.
        expect(existsSync(base)).toBe(true);
        expect(readdirSync(base)).toEqual([]);
    });

    test('the sweep reclaims exactly the name writeAtomic stages', async () => {
        const store = nextStore();
        const base = join(TEST_DIR, `store-${counter - 1}`, 'meta');
        await store.mkdir('meta');
        // What a crash between the staged write and its rename leaves: the rename fails and the tidy-up
        // unlink never runs.
        const renameSpy = spyOn(store, 'renameDurable').mockImplementation(async () => {
            throw new Error('EIO: rename');
        });
        const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async () => {});
        try {
            await expect(store.writeAtomic('meta/draft.json', '{}')).rejects.toThrow('EIO');
        } finally {
            renameSpy.mockRestore();
            unlinkSpy.mockRestore();
        }
        expect(readdirSync(base)).toHaveLength(1);
        backdate(join(base, readdirSync(base)[0] as string));

        await store.sweepAtomicTemps('meta', SWEEP_AGE_MS);

        expect(readdirSync(base)).toEqual([]);
    });

    test('a temp younger than the age is a write in flight and survives the sweep', async () => {
        const store = nextStore();
        const base = join(TEST_DIR, `store-${counter - 1}`, 'meta');
        await store.mkdir('meta');
        writeFileSync(join(base, '.draft.json.tmp-abc'), '{}');

        await store.sweepAtomicTemps('meta', SWEEP_AGE_MS);

        expect(readdirSync(base)).toEqual(['.draft.json.tmp-abc']);
    });
});

describe('unlinkDurable', () => {
    test('removes the file and fsyncs the directory that held its name', async () => {
        const store = nextStore();
        await store.write('cards/a.vcf', 'x');

        const synced = await recordSyncs(store, () => store.unlinkDurable('cards/a.vcf'));

        expect(await store.exists('cards/a.vcf')).toBe(false);
        expect(synced).toEqual(['cards']);
    });

    test('a file that is already gone is not an error', async () => {
        const store = nextStore();
        await store.mkdir('cards');

        await store.unlinkDurable('cards/ghost.vcf');
    });

    test('a non-ENOENT unlink failure stays fatal', async () => {
        const store = nextStore();
        await store.mkdir('cards/dir.vcf');

        // A directory in a file's place: the unlink itself fails, and that failure is the caller's to see.
        await expect(store.unlinkDurable('cards/dir.vcf')).rejects.toThrow();
        expect(existsSync(join(TEST_DIR, `store-${counter - 1}`, 'cards/dir.vcf'))).toBe(true);
    });

    test('a directory fsync the file system refuses does not fail the unlink', async () => {
        const store = nextStore();
        await store.write('cards/refused.vcf', 'x');
        const proto = await syncProto();
        const spy = spyOn(proto, 'sync').mockImplementation(async () => {
            throw new Error('EINVAL: fsync of a directory');
        });

        try {
            await store.unlinkDurable('cards/refused.vcf');
        } finally {
            spy.mockRestore();
        }

        expect(await store.exists('cards/refused.vcf')).toBe(false);
    });
});

describe('renameDurable', () => {
    test('publishing a staged file fsyncs only the directory that gained the name', async () => {
        const store = nextStore();
        await store.write('tmp/msg', 'x');
        await store.mkdir('new');

        const synced = await recordSyncs(store, () => store.renameDurable('tmp/msg', 'new/msg'));

        // Nothing indexes a staging name, so a second directory fsync would cost every delivery for nothing.
        expect(synced).toEqual(['new']);
        expect(await store.exists('new/msg')).toBe(true);
    });

    test('a rename within one directory fsyncs it once', async () => {
        const store = nextStore();
        await store.write('cur/msg', 'x');

        const synced = await recordSyncs(store, () => store.renameDurable('cur/msg', 'cur/msg:2,S'));

        expect(synced).toEqual(['cur']);
    });
});

describe('moveDurable', () => {
    test('a move between two indexed directories fsyncs the destination and then the source', async () => {
        const store = nextStore();
        await store.write('inbox/msg', 'x');
        await store.mkdir('trash');

        const synced = await recordSyncs(store, () => store.moveDurable('inbox/msg', 'trash/msg'));

        // The old name must not come back after the index says it moved, so both directories are on the platter.
        expect(synced).toEqual(['trash', 'inbox']);
        expect(await store.exists('trash/msg')).toBe(true);
    });

    test('a move within one directory fsyncs it once', async () => {
        const store = nextStore();
        await store.write('cur/msg', 'x');

        const synced = await recordSyncs(store, () => store.moveDurable('cur/msg', 'cur/other'));

        expect(synced).toEqual(['cur']);
    });

    test('a directory fsync the file system refuses does not fail the move', async () => {
        const store = nextStore();
        await store.write('inbox/refused', 'x');
        await store.mkdir('trash');
        const proto = await syncProto();
        const spy = spyOn(proto, 'sync').mockImplementation(async () => {
            throw new Error('EINVAL: fsync of a directory');
        });

        try {
            await store.moveDurable('inbox/refused', 'trash/refused');
        } finally {
            spy.mockRestore();
        }

        expect(await store.exists('trash/refused')).toBe(true);
    });
});
