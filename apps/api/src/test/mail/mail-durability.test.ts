import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, fstatSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { MAILBOX_DRAFTS, MAILBOX_TRASH } from '@workspace/lib/constants/mailboxes';
import { getHome } from '../../lib/home';
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

function maildir(): string {
    return join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'Maildir');
}

function boxDir(mailbox: string): string {
    return mailbox === '' ? maildir() : join(maildir(), `.${mailbox}`);
}

function makeEml(subject: string): Buffer {
    return Buffer.from(
        [
            'From: sender@example.com',
            'To: durability@test.eigen.is',
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${Date.now()}.${Math.random()}@test>`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'body',
        ].join('\r\n'),
        'utf-8',
    );
}

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
        const dirs = { tmp: join(boxDir(''), 'tmp'), new: join(boxDir(''), 'new'), cur: join(boxDir(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.mailboxDeliver(makeEml('Durable delivery'));
        });

        expect(events).toEqual(['file', 'rename', 'new', 'rename', 'cur']);
        expect(readdirSync(dirs.tmp)).toEqual([]);
    });

    test('a draft save fsyncs the EML before the rename into Drafts cur/', async () => {
        const home = await getHome(userId);
        const dirs = { tmp: join(boxDir(MAILBOX_DRAFTS), 'tmp'), cur: join(boxDir(MAILBOX_DRAFTS), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageHandleDraft({
                subject: 'Durable draft',
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'bob@test.eigen.is' },
                text: 'draft body',
                html: '<p>draft body</p>',
            });
        });

        // The sidecar write that follows is writeAtomic's own file + directory pair.
        expect(events.slice(0, 3)).toEqual(['file', 'rename', 'cur']);
        expect(readdirSync(dirs.tmp)).toEqual([]);
    });

    test('a flag change fsyncs the one directory its rename lands in', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(makeEml('Durable flag'));
        const dirs = { cur: join(boxDir(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageSetRead(messageId, true);
        });

        expect(events).toEqual(['rename', 'cur']);
    });

    test('a move fsyncs the target directory and then the one it left', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(makeEml('Durable move'));
        const dirs = { inbox: join(boxDir(''), 'cur'), trash: join(boxDir(MAILBOX_TRASH), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageMove(messageId, MAILBOX_TRASH);
        });

        expect(events).toEqual(['rename', 'trash', 'inbox']);
    });

    test('a delete fsyncs the directory after the unlink it made durable', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(makeEml('Durable delete'));
        const dirs = { cur: join(boxDir(''), 'cur') };

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
        const dirs = { new: join(boxDir('Batched'), 'new'), cur: join(boxDir('Batched'), 'cur') };
        for (const subject of ['One', 'Two', 'Three']) {
            const body = makeEml(subject);
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
        const dirs = { root: maildir(), box: boxDir('Created') };

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
            messageId = await home.mail.mailboxDeliver(makeEml('Refused directory fsync'));
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
            await expect(home.mail.mailboxDeliver(makeEml('Doomed delivery'))).rejects.toThrow('EIO');
        } finally {
            spy.mockRestore();
        }

        expect(readdirSync(join(boxDir(''), 'tmp'))).toEqual([]);
        expect(readdirSync(join(boxDir(''), 'new'))).toEqual([]);
    });

    test('a tmp/ file a crash left behind is swept after 36 hours', async () => {
        const home = await getHome(userId);
        const store = (home.mail as unknown as { store: { cleanupStaleDraftTemps: () => Promise<void> } }).store;
        const tmpDir = join(boxDir(''), 'tmp');
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
});
