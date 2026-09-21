import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, fstatSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { MAILBOX_DRAFTS, MAILBOX_TRASH } from '@workspace/lib/constants/mailboxes';
import { getHome } from '../../lib/home';
import { boxDir, maildirOf, mailRootOf, makeEml } from '../mail-test-helpers';
import { createTestUser, ensureServer, TEST_DATA_DIR } from '../setup';

// Durability can only be proven by killing the machine, so what these tests pin is the protocol that buys
// it: the bytes are fsynced before the rename that publishes them, and every directory whose entries the
// index depends on is fsynced after. Each maildir write path is driven through the mail domain while
// FileHandle.sync and fs.promises.rename are spied, and every synced fd is identified by its inode.

let userId: string;
let counter = 0;

beforeAll(async () => {
    await ensureServer();
    const user = await createTestUser(`durability-${Date.now()}@test.eigen.is`, 'testpassword123', 'Durability');
    userId = user.id;
    // The welcome mail is appended with skipSync; one listing indexes it, so new/ is empty below.
    const home = await getHome(userId);
    await home.mail.mailboxGet('');
});

const box = (mailbox: string) => boxDir(userId, mailbox);

const eml = (subject: string) => Buffer.from(makeEml(subject, { to: 'durability@test.eigen.is' }), 'utf-8');

async function syncProto(): Promise<{ sync: () => Promise<void> }> {
    const probe = await open(TEST_DATA_DIR, 'r');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    return proto;
}

// Labels every sync, rename and unlink the operation performs: a directory by the name the caller gave its
// path, anything else by kind. Inodes identify the directories because a file descriptor carries no path,
// and they are resolved after the fact so a directory the operation itself creates can be labeled too.
async function record(dirs: Record<string, string>, fn: () => Promise<void>): Promise<string[]> {
    const handleProto = await syncProto();

    const events: (string | number)[] = [];
    const realSync = handleProto.sync;
    const syncSpy = spyOn(handleProto, 'sync').mockImplementation(async function (this: FileHandle) {
        const stat = fstatSync(this.fd);
        events.push(stat.isDirectory() ? stat.ino : 'file');
        return realSync.call(this);
    });
    const realRename = fsPromises.rename;
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        events.push('rename');
        return realRename(from, to);
    });
    const realUnlink = fsPromises.unlink;
    const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
        events.push('unlink');
        return realUnlink(target);
    });

    try {
        await fn();
    } finally {
        syncSpy.mockRestore();
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
    }

    const byIno = new Map<number, string>();
    for (const [label, dir] of Object.entries(dirs)) byIno.set(statSync(dir).ino, label);
    return events.map((event) => (typeof event === 'string' ? event : (byIno.get(event) ?? 'other dir')));
}

describe('Maildir write durability', () => {
    test('a delivery fsyncs the message, then new/, then cur/ once the sync moves it', async () => {
        const home = await getHome(userId);
        const dirs = { tmp: join(box(''), 'tmp'), new: join(box(''), 'new'), cur: join(box(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.mailboxDeliver(eml('Durable delivery'));
        });

        // Publishing out of tmp/ does not fsync the staging directory: nothing indexes a name there, and a
        // resurrected one is swept.
        expect(events).toEqual(['file', 'rename', 'new', 'rename', 'cur']);
        expect(readdirSync(dirs.tmp)).toEqual([]);
    });

    test('a draft save fsyncs the EML before the rename into Drafts cur/', async () => {
        const home = await getHome(userId);
        const dirs = {
            tmp: join(box(MAILBOX_DRAFTS), 'tmp'),
            cur: join(box(MAILBOX_DRAFTS), 'cur'),
            meta: join(mailRootOf(userId), 'draft-meta'),
        };

        const events = await record(dirs, async () => {
            await home.mail.messageHandleDraft({
                subject: 'Durable draft',
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'bob@test.eigen.is' },
                text: 'draft body',
                html: '<p>draft body</p>',
            });
        });

        // The EML, then the sidecar write that follows — writeAtomic's own file + directory pair.
        expect(events).toEqual(['file', 'rename', 'cur', 'file', 'rename', 'meta']);
        expect(readdirSync(dirs.tmp)).toEqual([]);
    });

    test('a flag change fsyncs the one directory its rename lands in', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(eml('Durable flag'));
        const dirs = { cur: join(box(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageSetRead(messageId, true);
        });

        expect(events).toEqual(['rename', 'cur']);
    });

    test('a move fsyncs the target directory and then the one it left', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(eml('Durable move'));
        const dirs = { inbox: join(box(''), 'cur'), trash: join(box(MAILBOX_TRASH), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageMove(messageId, MAILBOX_TRASH);
        });

        expect(events).toEqual(['rename', 'trash', 'inbox']);
    });

    test('a delete fsyncs the directory after the unlink it made durable', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(eml('Durable delete'));
        const dirs = { cur: join(box(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageDelete(messageId);
        });

        expect(events).toEqual(['unlink', 'cur']);
    });

    test('new/ to cur/ fsyncs cur/ once for the whole batch', async () => {
        // A cold sync of a large new/ would otherwise pay one directory fsync per message for the one
        // directory every rename lands in.
        const home = await getHome(userId);
        await home.mail.mailboxCreate('Batched');
        const dirs = { new: join(box('Batched'), 'new'), cur: join(box('Batched'), 'cur') };
        for (const subject of ['One', 'Two', 'Three']) {
            const body = eml(subject);
            writeFileSync(join(dirs.new, `${Date.now()}.M${counter++}P1Q1.host,S=${body.byteLength}`), body);
        }

        const events = await record(dirs, async () => {
            await home.mail.mailboxGet('Batched');
        });

        expect(events).toEqual(['rename', 'rename', 'rename', 'cur']);
        expect(readdirSync(dirs.new)).toEqual([]);
        expect(readdirSync(dirs.cur)).toHaveLength(3);
    });

    test('creating a mailbox fsyncs the folder and the Maildir root that gained it', async () => {
        const home = await getHome(userId);
        const dirs = { root: maildirOf(userId), box: box('Created') };

        const events = await record(dirs, async () => {
            await home.mail.mailboxCreate('Created');
        });

        expect(events).toEqual(['box', 'root']);
    });

    test('a delivery survives a directory fsync the file system refuses', async () => {
        // The message is already in new/ when a directory fsync fails, so failing the delivery would make
        // the sending MTA retry a message that landed — every retry a duplicate.
        const home = await getHome(userId);
        const handleProto = await syncProto();
        const realSync = handleProto.sync;
        const spy = spyOn(handleProto, 'sync').mockImplementation(async function (this: FileHandle) {
            if (fstatSync(this.fd).isDirectory()) throw new Error('EINVAL: fsync of a directory');
            return realSync.call(this);
        });

        let messageId: string;
        try {
            messageId = await home.mail.mailboxDeliver(eml('Refused directory fsync'));
        } finally {
            spy.mockRestore();
        }

        expect(home.mail.messageGetSummary(messageId)?.subject).toBe('Refused directory fsync');
    });

    test('a failed file fsync fails the delivery and stages nothing', async () => {
        const home = await getHome(userId);
        const handleProto = await syncProto();
        const realSync = handleProto.sync;
        const spy = spyOn(handleProto, 'sync').mockImplementation(async function (this: FileHandle) {
            if (!fstatSync(this.fd).isDirectory()) throw new Error('EIO: fsync of the staged message');
            return realSync.call(this);
        });

        try {
            await expect(home.mail.mailboxDeliver(eml('Doomed delivery'))).rejects.toThrow('EIO');
        } finally {
            spy.mockRestore();
        }

        expect(readdirSync(join(box(''), 'tmp'))).toEqual([]);
        expect(readdirSync(join(box(''), 'new'))).toEqual([]);
    });

    test('a new/ rename that fails without an errno fails the sync instead of vanishing', async () => {
        const home = await getHome(userId);
        const realRename = fsPromises.rename;
        // Only the new/ → cur/ sweep; the delivery's own tmp/ → new/ rename still has to land.
        const spy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
            if (String(from).includes('/new/')) throw new Error('rename refused');
            return realRename(from, to);
        });

        try {
            await expect(home.mail.mailboxDeliver(eml('Code-less rename'))).rejects.toThrow('rename refused');
        } finally {
            spy.mockRestore();
        }
    });

    test('a tmp/ file a crash left behind is swept after 36 hours', async () => {
        const home = await getHome(userId);
        const store = (home.mail as unknown as { store: { cleanupStaleDraftTemps: () => Promise<void> } }).store;
        const tmpDir = join(box(''), 'tmp');
        const stale = join(tmpDir, 'stale.M1P1Q1.host,S=4');
        const fresh = join(tmpDir, 'fresh.M1P1Q1.host,S=4');
        writeFileSync(stale, 'body');
        writeFileSync(fresh, 'body');
        const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
        utimesSync(stale, old, old);

        await store.cleanupStaleDraftTemps();

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
    });

    test('an atomic temp a crash left in draft-meta/ is swept, and a real sidecar is not', async () => {
        const home = await getHome(userId);
        const store = (home.mail as unknown as { store: { cleanupStaleDraftTemps: () => Promise<void> } }).store;
        const metaDir = join(mailRootOf(userId), 'draft-meta');
        mkdirSync(metaDir, { recursive: true });
        const temp = join(metaDir, '.draft-1.json.tmp-abc');
        const sidecar = join(metaDir, 'draft-1.json');
        writeFileSync(temp, '{}');
        writeFileSync(sidecar, '{}');

        await store.cleanupStaleDraftTemps();

        expect(existsSync(temp)).toBe(false);
        expect(existsSync(sidecar)).toBe(true);
    });
});
