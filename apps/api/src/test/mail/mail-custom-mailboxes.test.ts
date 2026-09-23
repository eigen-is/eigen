import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_ARCHIVE, STANDARD_MAILBOXES } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { boxDir, makeEml, seedMaildirFile } from '../mail-test-helpers';
import { app, assertJson, authedRequest, createTestUser, ensureServer, findOrFail } from '../setup';

const isWindows = process.platform === 'win32';

// createTestUser hits the auth DB directly, so the setup wizard must have run first.
beforeAll(async () => {
    await ensureServer();
});

// Fabricates a Maildir++ folder the way Dovecot does: a dot-prefixed directory with cur/new/tmp and
// the `maildirfolder` marker, never touched by Eigen's own mailbox creation.
function seedMaildirFolder(userId: string, mailbox: string): void {
    const folder = boxDir(userId, mailbox);
    for (const sub of ['cur', 'new', 'tmp']) mkdirSync(join(folder, sub), { recursive: true });
    writeFileSync(join(folder, 'maildirfolder'), '');
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
    let email: string;

    beforeAll(async () => {
        email = `custombox-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'Custom Box Test');
        userId = user.id;
        token = user.sessionToken;
        // Initialize the home: creates the Maildir tree before anything is seeded into it.
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        seedMaildirFolder(userId, 'Projects');
        projectsId = `${Date.now()}.projects`;
        seedMaildirFile(userId, 'Projects', projectsId, makeEml('From an IMAP client', { to: email }), {
            dir: 'new',
        });
        seedMaildirFolder(userId, 'Clients.Acme');
        seedMaildirFolder(userId, 'My Stuff');
        // Names Eigen refuses: an empty hierarchy segment and a control character. Dovecot may hold
        // either; both are skipped rather than failing the whole listing.
        seedMaildirFolder(userId, 'bad..name');
        seedMaildirFolder(userId, 'ctrl\u0001name');
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

    test('a nested folder addressed with / is the one dotted folder everywhere', async () => {
        const raw = makeEml('Filed under a slash', { to: email });
        expect(
            (
                await app.handle(
                    new Request(`http://localhost/mail/deliver/${email}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'message/rfc822' },
                        body: new TextEncoder().encode(raw).buffer as ArrayBuffer,
                    }),
                )
            ).status,
        ).toBe(200);

        const inbox = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/inbox`));
        const moved = findOrFail(inbox, (message) => message.subject === 'Filed under a slash');

        const res = await authedRequest(token, `/mail/${userId}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: moved.id, targetMailbox: 'Clients/Acme' }),
        });
        expect(res.status).toBe(200);

        // Before anything opens the folder — a listing never syncs, so it reports the row exactly as the
        // move wrote it: under the one dotted name, not a second spelling nothing enumerates.
        const boxes = await listMailboxes(token, userId);
        expect(boxes.filter((box) => box.path.startsWith('Clients')).map((box) => box.path)).toEqual(['Clients.Acme']);
        expect(findOrFail(boxes, (box) => box.path === 'Clients.Acme').total).toBe(1);

        const dotted = await assertJson<EmailSummary[]>(
            await authedRequest(token, `/mail/${userId}/mailbox/Clients.Acme`),
        );
        expect(dotted.map((message) => message.id)).toEqual([moved.id]);
        expect(dotted[0].mailbox).toBe('Clients.Acme');
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

// Eigen nests no folders itself, but Dovecot does: `.Clients` beside `.Clients.Acme` makes Clients a parent.
describe.skipIf(isWindows)('A folder with a folder nested under it', () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
        const user = await createTestUser(`nested-${Date.now()}@test.eigen.is`, 'testpassword123', 'Nested Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        seedMaildirFolder(userId, 'Clients');
        seedMaildirFolder(userId, 'Clients.Acme');
        // Shares the prefix without the delimiter, so it is a sibling, not a child.
        seedMaildirFolder(userId, 'ClientsOld');
    });

    test('the parent is listed with children, the child and the sibling without', async () => {
        const boxes = await listMailboxes(token, userId);
        expect(findOrFail(boxes, (box) => box.path === 'Clients').flags).toEqual(['\\HasChildren']);
        expect(findOrFail(boxes, (box) => box.path === 'Clients.Acme').flags).toEqual(['\\HasNoChildren']);
        expect(findOrFail(boxes, (box) => box.path === 'ClientsOld').flags).toEqual(['\\HasNoChildren']);
        expect(findOrFail(boxes, (box) => box.path === MAILBOX_ARCHIVE).flags).toEqual([
            '\\HasNoChildren',
            '\\Archive',
        ]);
    });

    test('a lookup of the parent reports its children too', async () => {
        const exists = await assertJson<MaildirMailbox | false>(
            await authedRequest(token, `/mail/${userId}/mailbox-exists/Clients`),
        );
        expect(exists).not.toBe(false);
        expect((exists as MaildirMailbox).flags).toEqual(['\\HasChildren']);
    });
});

// Dovecot writes a name holding `&` or anything outside printable ASCII in modified UTF-7, and leaves the
// rest of printable ASCII alone: all of these are folder names Eigen must list, open and move into.
describe.skipIf(isWindows)('A folder name outside the ASCII letters and digits', () => {
    const NAMES = ['&AMQ-rger', 'R&-D', "O'Brien", 'C++'];
    let userId: string;
    let token: string;
    let email: string;

    const openBox = (name: string) =>
        authedRequest(token, `/mail/${userId}/mailbox/${encodeURIComponent(name)}`).then((res) =>
            assertJson<EmailSummary[]>(res),
        );

    beforeAll(async () => {
        email = `oddname-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'Odd Name Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        for (const name of NAMES) {
            seedMaildirFolder(userId, name);
            seedMaildirFile(
                userId,
                name,
                `${Date.now()}.${NAMES.indexOf(name)}.odd`,
                makeEml(`Filed under ${name}`, { to: email }),
                { dir: 'new' },
            );
        }
    });

    test('every such folder is listed, opens, and counts what it holds', async () => {
        const boxes = await listMailboxes(token, userId);
        expect(boxes.map((box) => box.path)).toEqual(expect.arrayContaining(NAMES));

        for (const name of NAMES) {
            const box = await mailboxWhenCounting(token, userId, name, 1);
            expect(box.unread).toBe(1);
            expect((await openBox(name)).map((message) => message.subject)).toEqual([`Filed under ${name}`]);
        }
    });

    test('a message moves into such a folder and is listed there', async () => {
        const raw = makeEml('Moved by hand', { to: email });
        expect(
            (
                await app.handle(
                    new Request(`http://localhost/mail/deliver/${email}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'message/rfc822' },
                        body: new TextEncoder().encode(raw).buffer as ArrayBuffer,
                    }),
                )
            ).status,
        ).toBe(200);

        const inbox = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/inbox`));
        const moved = findOrFail(inbox, (message) => message.subject === 'Moved by hand');

        const res = await authedRequest(token, `/mail/${userId}/message/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: moved.id, targetMailbox: "O'Brien" }),
        });
        expect(res.status).toBe(200);
        expect((await openBox("O'Brien")).map((message) => message.id)).toContain(moved.id);
    });
});

// Anything that would break a path or the Maildir++ hierarchy, refused at every entry that builds a
// directory from a name — never mapped onto a safe one, which would make two names one folder.
describe.skipIf(isWindows)('A folder name that cannot address a directory', () => {
    const REFUSED = ['..', '.hidden', 'a/../b', 'ctrl\u0001name', 'bad..name', ' leading', 'trailing '];
    let userId: string;
    let token: string;
    let messageId: string;

    beforeAll(async () => {
        const email = `badname-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'Bad Name Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        const raw = makeEml('Stays where it is', { to: email });
        await app.handle(
            new Request(`http://localhost/mail/deliver/${email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(raw).buffer as ArrayBuffer,
            }),
        );
        const inbox = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/inbox`));
        messageId = findOrFail(inbox, (message) => message.subject === 'Stays where it is').id;
    });

    test('creating one is refused', async () => {
        for (const mailbox of REFUSED) {
            const res = await authedRequest(token, `/mail/${userId}/mailbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mailbox }),
            });
            expect([mailbox, res.status]).toEqual([mailbox, 400]);
        }
    });

    test('opening one is refused', async () => {
        // `..` never reaches the route: the URL it spells normalizes away the segment, so the router 404s.
        for (const mailbox of REFUSED.filter((name) => name !== '..')) {
            const res = await authedRequest(
                token,
                `/mail/${userId}/mailbox/${encodeURIComponent(mailbox).replaceAll('.', '%2E')}`,
            );
            expect([mailbox, res.status]).toEqual([mailbox, 400]);
        }
    });

    test('moving a message into one is refused and leaves the message where it was', async () => {
        for (const targetMailbox of REFUSED) {
            const res = await authedRequest(token, `/mail/${userId}/message/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId, targetMailbox }),
            });
            expect([targetMailbox, res.status]).toEqual([targetMailbox, 400]);
        }

        const inbox = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/inbox`));
        expect(inbox.map((message) => message.id)).toContain(messageId);
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

        const eml = makeEml('Delivered to the real inbox', { to: email });
        const delivered = await app.handle(
            new Request(`http://localhost/mail/deliver/${email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
            }),
        );
        expect(delivered.status).toBe(200);

        // Dovecot never makes this folder, but a restore or a stray client can leave one behind.
        seedMaildirFolder(userId, 'INBOX');
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
    const filedId = `${Date.now()}.filed`;

    beforeAll(async () => {
        email = `nowatcher-${Date.now()}@test.eigen.is`;
        const user = await createTestUser(email, 'testpassword123', 'No Watcher Test');
        userId = user.id;
        token = user.sessionToken;
        expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);

        seedMaildirFolder(userId, 'Filed');
        seedMaildirFile(
            userId,
            'Filed',
            `${Date.now()}.first`,
            makeEml('Filed before the first listing', { to: email }),
            { dir: 'new' },
        );
    });

    test('listings inside the interval kick no second reconcile', async () => {
        expect((await mailboxWhenCounting(token, userId, 'Filed', 1)).total).toBe(1);
        // The reconcile that listing kicked reads the directory before the message below is written.
        await Bun.sleep(100);

        seedMaildirFile(userId, 'Filed', filedId, makeEml('Filed by an IMAP client', { to: email }), { dir: 'new' });

        // No watcher on this folder, and its reconcile is due again only after a minute: every listing
        // reports the index as it stands, and none of them rescans the folder.
        for (let attempt = 0; attempt < 5; attempt++) {
            expect(findOrFail(await listMailboxes(token, userId), (box) => box.path === 'Filed').total).toBe(1);
            await Bun.sleep(50);
        }
    });

    test('opening the folder reconciles it regardless, and that message announces new mail', async () => {
        let messages: EmailSummary[] = [];
        for (let attempt = 0; attempt < 100; attempt++) {
            messages = await assertJson<EmailSummary[]>(await authedRequest(token, `/mail/${userId}/mailbox/Filed`));
            if (messages.some((message) => message.id === filedId)) break;
            await Bun.sleep(20);
        }
        expect(messages.map((message) => message.id)).toContain(filedId);
        expect(await mailNotificationCount(token, userId)).toBe(1);
    });

    test('a folder opened again picks up what was filed while it was closed', async () => {
        const openedId = `${Date.now()}.opened`;
        seedMaildirFile(userId, 'Filed', openedId, makeEml('Filed while the folder was closed', { to: email }), {
            dir: 'new',
        });

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
