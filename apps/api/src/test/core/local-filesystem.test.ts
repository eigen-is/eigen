import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFilesystem } from '../../lib/core';

// Durability can only be proven by killing the machine, so what these pin is the protocol that buys it: the
// directory holding a name is fsynced after the operation that changed it, and a file system that refuses a
// directory fsync (NFS, CIFS, some FUSE mounts) never fails an operation that already happened.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-local-filesystem-${Date.now()}`);
let counter = 0;
const nextStore = () => new LocalFilesystem(join(TEST_DIR, `store-${counter++}`));

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
