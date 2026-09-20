import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STANDARD_MAILBOXES } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, createTestUser, ensureServer, findOrFail, TEST_DATA_DIR } from '../setup';

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

    test('a folder an IMAP client created is listed with its own total and unread counts', async () => {
        const boxes = await assertJson<MaildirMailbox[]>(await authedRequest(token, `/mail/${userId}/mailboxes`));
        const projects = findOrFail(boxes, (box) => box.path === 'Projects');
        expect(projects.total).toBe(1);
        expect(projects.unread).toBe(1);
        expect(projects.name).toBe('Projects');
        expect(projects.flags).toEqual(['\\HasNoChildren']);
    });

    test('the standard six are listed once each, first and in their canonical order', async () => {
        const boxes = await assertJson<MaildirMailbox[]>(await authedRequest(token, `/mail/${userId}/mailboxes`));
        expect(boxes.slice(0, STANDARD_MAILBOXES.length).map((box) => box.path)).toEqual([...STANDARD_MAILBOXES]);
        const custom = boxes.slice(STANDARD_MAILBOXES.length).map((box) => box.path);
        expect(custom).toEqual(['Clients.Acme', 'My Stuff', 'Projects']);
    });

    test('a folder name Eigen refuses is skipped without failing the listing', async () => {
        const boxes = await assertJson<MaildirMailbox[]>(await authedRequest(token, `/mail/${userId}/mailboxes`));
        expect(boxes.some((box) => box.path.includes('..'))).toBe(false);
        expect(boxes.some((box) => box.path.includes('\u0001'))).toBe(false);
    });

    test('a nested folder is listed under its dotted path and lists its messages', async () => {
        const boxes = await assertJson<MaildirMailbox[]>(await authedRequest(token, `/mail/${userId}/mailboxes`));
        const acme = findOrFail(boxes, (box) => box.path === 'Clients.Acme');
        expect(acme.name).toBe('Acme');

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
});
