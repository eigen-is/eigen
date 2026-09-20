import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { fstatSync, readdirSync, statSync } from 'node:fs';
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

// Labels every sync and rename the operation performs: a directory by the name the caller gave its path,
// anything else by kind. Inodes identify the directories because a file descriptor carries no path.
async function record(dirs: Record<string, string>, fn: () => Promise<void>): Promise<string[]> {
    const byIno = new Map<number, string>();
    for (const [label, dir] of Object.entries(dirs)) byIno.set(statSync(dir).ino, label);

    const probe = await open(TEST_DATA_DIR, 'r');
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();

    const events: string[] = [];
    const realSync = handleProto.sync;
    const syncSpy = spyOn(handleProto, 'sync').mockImplementation(async function (this: FileHandle) {
        const stat = fstatSync(this.fd);
        events.push(stat.isDirectory() ? (byIno.get(stat.ino) ?? 'other dir') : 'file');
        return realSync.call(this);
    });
    const realRename = fsPromises.rename;
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        events.push('rename');
        return realRename(from, to);
    });

    try {
        await fn();
    } finally {
        syncSpy.mockRestore();
        renameSpy.mockRestore();
    }
    return events;
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

    test('a delete fsyncs the directory the message was unlinked from', async () => {
        const home = await getHome(userId);
        const messageId = await home.mail.mailboxDeliver(makeEml('Durable delete'));
        const dirs = { cur: join(boxDir(''), 'cur') };

        const events = await record(dirs, async () => {
            await home.mail.messageDelete(messageId);
        });

        expect(events).toEqual(['cur']);
    });
});
