import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_ARCHIVE, STANDARD_MAILBOXES } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { app, assertJson, authedRequest, createTestUser, ensureServer, findOrFail, TEST_DATA_DIR } from '../setup';

const isWindows = process.platform === 'win32';

// createTestUser hits the auth DB directly, so the setup wizard must have run first.
beforeAll(async () => {
    await ensureServer();
});

function maildirOf(userId: string) {
    return join(TEST_DATA_DIR, 'home', userId, 'eigen.mail', 'Maildir');
}

// Fabricates a Maildir++ folder the way Dovecot does: a dot-prefixed directory with cur/new/tmp and
// the `maildirfolder` marker, never touched by Eigen's own mailbox creation.
function seedMaildirFolder(userId: string, dirName: string): string {
    const folder = join(maildirOf(userId), dirName);
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(folder, sub), { recursive: true });
    writeFileSync(join(folder, 'maildirfolder'), '');
    return folder;
}

function makeEml(subject: string, to: string) {
    return [
        'From: sender@example.com',
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${Math.random()}@test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Body of ${subject}`,
    ].join('\r\n');
}

// A message an IMAP client delivered: it lands in new/ with no flag suffix, so it is unread.
function seedNewFile(folder: string, uniqueId: string, eml: string): void {
    writeFileSync(join(folder, 'new', `${uniqueId},S=${Buffer.byteLength(eml, 'utf-8')}`), eml);
}

function listMailboxes(token: string, userId: string): Promise<MaildirMailbox[]> {
    return authedRequest(token, `/mail/${userId}/mailboxes`).then((res) => assertJson<MaildirMailbox[]>(res));
}

// A listing never indexes, so a folder reports its counts only once the background reconcile it
// kicks has landed.
async function mailboxWhenCounting(
    token: string,
    userId: string,
    path: string,
    total: number,
): Promise<MaildirMailbox> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const box = findOrFail(await listMailboxes(token, userId), (mailbox) => mailbox.path === path);
        if (box.total >= total) return box;
        await Bun.sleep(20);
    }
    throw new Error(`Mailbox '${path}' never reached ${total} messages`);
}

async function mailNotificationCount(token: string, userId: string): Promise<number> {
    const rows = await assertJson<Notification[]>(await authedRequest(token, `/notifications/${userId}`));
    return rows.filter((row) => row.tag === 'mail:new').length;
}

describe.skipIf(isWindows)('Mailboxes outside the standard six', () => {
    let userId: string;
    let token: string;
    let projectsId: string;

    beforeAll(async () => {
        const email = `custombox-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'Custom Box Test');
        userId = user.id;
        token = user.sessionToken;
        // Initialize the home: creates the Maildir tree before anything is seeded into it.
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        const projects = seedMaildirFolder(userId, '.Projects');
        projectsId = `${Date.now()}.projects`;
        seedNewFile(projects, projectsId, makeEml('From an IMAP client', email));
        seedMaildirFolder(userId, '.Clients.Acme');
        seedMaildirFolder(userId, '.My Stuff');
        // Names Eigen refuses: an empty hierarchy segment and a control character. Dovecot may hold
        // either; both are skipped rather than failing the whole listing.
        seedMaildirFolder(userId, '.bad..name');
        seedMaildirFolder(userId, '.ctrl\u0001name');
    });

    test('a folder an IMAP client created is listed at once, and indexed in the background', async () => {
        const first = await listMailboxes(token, userId);
        expect(findOrFail(first, (box) => box.path === 'Projects').total).toBe(0);

        const projects = await mailboxWhenCounting(token, userId, 'Projects', 1);
        expect(projects.total).toBe(1);
        expect(projects.unread).toBe(1);
        expect(projects.flags).toEqual(['\\HasNoChildren']);
    });

    test('a first index is discovery, so an old folder announces no new mail', async () => {
        await mailboxWhenCounting(token, userId, 'Projects', 1);
        expect(await mailNotificationCount(token, userId)).toBe(0);
    });

    test('the standard six are listed once each, first and in their canonical order', async () => {
        const boxes = await listMailboxes(token, userId);
        expect(boxes.slice(0, STANDARD_MAILBOXES.length).map((box) => box.path)).toEqual([...STANDARD_MAILBOXES]);
        const custom = boxes.slice(STANDARD_MAILBOXES.length).map((box) => box.path);
        expect(custom).toEqual(['Clients.Acme', 'My Stuff', 'Projects']);
    });

    test('a folder name Eigen refuses is skipped without failing the listing', async () => {
        const boxes = await listMailboxes(token, userId);
        expect(boxes.some((box) => box.path.includes('..'))).toBe(false);
        expect(boxes.some((box) => box.path.includes('\u0001'))).toBe(false);
    });

    test('a nested folder is listed under its dotted path and lists its messages', async () => {
        const boxes = await listMailboxes(token, userId);
        expect(findOrFail(boxes, (box) => box.path === 'Clients.Acme').flags).toEqual(['\\HasNoChildren']);

        const messages = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${userId}/mailbox/Clients.Acme`),
        );
        expect(messages).toEqual([]);
    });

    test('opening a custom folder lists the message the IMAP client left there', async () => {
        const messages = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${userId}/mailbox/Projects`),
        );
        expect(messages.map((m) => m.id)).toEqual([projectsId]);
        expect(messages[0].subject).toBe('From an IMAP client');
        expect(messages[0].isRead).toBe(false);
    });

    test('a folder name with a space is addressed percent-encoded in the URL', async () => {
        const res = await authedRequest(token, `/mail/${userId}/mailbox/My%20Stuff`);
        expect(res.status).toBe(200);
        const exists = await assertJson<MaildirMailbox | false>(
            await authedRequest(token, `/mail/${userId}/mailbox-exists/My%20Stuff`),
        );
        expect(exists).not.toBe(false);
        expect((exists as MaildirMailbox).path).toBe('My Stuff');
    });

    test('a name that case-folds onto a standard mailbox addresses that one, not a second folder', async () => {
        const res = await authedRequest(token, `/mail/${userId}/mailbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailbox: MAILBOX_ARCHIVE.toLowerCase() }),
        });
        expect(res.status).toBe(409);

        const boxes = await listMailboxes(token, userId);
        expect(boxes.filter((box) => box.path.toLowerCase() === MAILBOX_ARCHIVE.toLowerCase())).toHaveLength(1);
    });
});

describe.skipIf(isWindows)('A .INBOX folder is the Maildir root, not a mailbox of its own', () => {
    let userId: string;
    let token: string;
    let email: string;

    beforeAll(async () => {
        email = `inboxalias-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'Inbox Alias Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        const eml = makeEml('Delivered to the real inbox', email);
        const delivered = await app.handle(
            new Request(`http://localhost/mail/deliver/${email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
            }),
        );
        expect(delivered.status).toBe(200);

        // Dovecot never makes this folder, but a restore or a stray client can leave one behind.
        seedMaildirFolder(userId, '.INBOX');
    });

    test('listing twice leaves the inbox holding its message and lists no INBOX folder', async () => {
        const first = await listMailboxes(token, userId);
        expect(first.some((box) => box.path === 'INBOX')).toBe(false);

        const second = await listMailboxes(token, userId);
        expect(second.some((box) => box.path === 'INBOX')).toBe(false);

        const inbox = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/inbox`));
        expect(inbox.map((message) => message.subject)).toContain('Delivered to the real inbox');
    });
});

describe.skipIf(isWindows)('A folder outside the standard six stays fresh without a watcher', () => {
    let userId: string;
    let token: string;
    let email: string;
    let folder: string;
    const filedId = `${Date.now()}.filed`;

    beforeAll(async () => {
        email = `nowatcher-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'No Watcher Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        folder = seedMaildirFolder(userId, '.Filed');
        seedNewFile(folder, `${Date.now()}.first`, makeEml('Filed before the first listing', email));
    });

    test('no watcher picks up a message filed into it, and the next listing reports it', async () => {
        expect((await mailboxWhenCounting(token, userId, 'Filed', 1)).total).toBe(1);
        // The reconcile that listing kicked reads the directory before the message below is written.
        await Bun.sleep(100);

        seedNewFile(folder, filedId, makeEml('Filed by an IMAP client', email));
        await Bun.sleep(300);

        // No watcher on this folder, so nothing has seen the file yet: this listing reports the index
        // as it stands and kicks the reconcile that finds it.
        const stale = findOrFail(await listMailboxes(token, userId), (box) => box.path === 'Filed');
        expect(stale.total).toBe(1);

        const settled = await mailboxWhenCounting(token, userId, 'Filed', 2);
        expect(settled.total).toBe(2);
        expect(settled.unread).toBe(2);
    });

    test('a message filed into an already-indexed folder announces new mail', async () => {
        expect(await mailNotificationCount(token, userId)).toBe(1);
    });

    test('opening the folder reconciles it, without a listing in between', async () => {
        const openedId = `${Date.now()}.opened`;
        seedNewFile(folder, openedId, makeEml('Filed while the folder was closed', email));

        let messages: EmailSummary[] = [];
        for (let attempt = 0; attempt < 100; attempt++) {
            messages = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/Filed`));
            if (messages.some((message) => message.id === openedId)) break;
            await Bun.sleep(20);
        }
        expect(messages.map((message) => message.id)).toContain(filedId);
        expect(messages.map((message) => message.id)).toContain(openedId);
    });
});
