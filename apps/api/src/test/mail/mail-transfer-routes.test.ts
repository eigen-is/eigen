import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { type DrivePath, EML_MIME } from '@workspace/lib/types/drive';
import type { Email, EmailSummary, ImportMailResult } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getMailDomain } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import {
    app,
    assertJson,
    authedRequest,
    createTestUser,
    driveGet,
    drivePost,
    driveUpload,
    findOrFail,
    firstMountId,
    getTestContext,
    type TestUser,
} from '../setup';

const PASSWORD = 'testpassword123';

// A saved message the way a mail client writes one to disk: CRLF, a body, and nothing Eigen minted.
const message = (subject: string, parts: string[] = ['Saved from another client.']) =>
    [
        'From: Grace Hopper <grace@eml-import.example>',
        'To: alice@eml-import.example',
        `Subject: ${subject}`,
        `Message-ID: <${randomUUID()}@eml-import.example>`,
        'Date: Mon, 20 Apr 2026 10:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        ...parts,
    ].join('\r\n');

// Own users, never the shared ctx home: the counts below are exact and other mail suites deliver into alice.
describe('Mail transfer routes', () => {
    let alice: TestUser;
    let bob: TestUser;
    let mountId: string;
    let rootId: string;
    let bobMountId: string;
    let bobRootId: string;
    let guestToken: string;
    let guestId: string;

    const importRequest = (user: TestUser, body: BodyInit, headers: Record<string, string> = {}) =>
        authedRequest(user.sessionToken, `/mail/${user.id}/import`, {
            method: 'POST',
            headers: { 'Content-Type': EML_MIME, ...headers },
            body,
        });

    const importFromDrive = (user: TestUser, source: DrivePath) =>
        authedRequest(user.sessionToken, `/mail/${user.id}/import-from-drive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceOwnerId: source.ownerId,
                sourceMountId: source.mountId,
                sourcePathId: source.id,
            }),
        });

    const inbox = async (user: TestUser): Promise<EmailSummary[]> => {
        const res = await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/inbox`);
        return assertJson<EmailSummary[]>(res);
    };

    const newMailNotifications = async (user: TestUser): Promise<Notification[]> => {
        const res = await authedRequest(user.sessionToken, `/notifications/${user.id}`);
        return (await assertJson<Notification[]>(res)).filter((n) => n.tag === 'mail:new');
    };

    const deliver = (to: string, raw: string) =>
        app.handle(
            new Request(`http://localhost/mail/deliver/${to}`, {
                method: 'POST',
                headers: { 'Content-Type': EML_MIME },
                body: raw,
            }),
        );

    const uploadEml = async (text: string, name = 'saved.eml'): Promise<DrivePath> => {
        const file = new File([new TextEncoder().encode(text)], name, { type: EML_MIME });
        return driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);
    };

    beforeAll(async () => {
        await getTestContext();
        alice = await createTestUser('eml-import-alice@test.eigen.is', PASSWORD, 'Eml Import Alice');
        bob = await createTestUser('eml-import-bob@test.eigen.is', PASSWORD, 'Eml Import Bob');

        mountId = await firstMountId(alice.sessionToken, alice.id);
        rootId = (await driveGet(alice.sessionToken, alice.id, mountId, 'root')).id;
        bobMountId = await firstMountId(bob.sessionToken, bob.id);
        bobRootId = (await driveGet(bob.sessionToken, bob.id, bobMountId, 'root')).id;

        const email = `eml-import-guest-${randomUUID()}@external.com`;
        const password = randomUUID();
        const created = await auth.api.createUser({ body: { email, password, name: 'Import Guest', role: 'user' } });
        // Set to 'guest' directly — the admin plugin only allows 'user'/'admin' via the API.
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        guestToken = (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';
        guestId = created.user.id;
    });

    test('an imported message lands unread in the inbox and reads back byte for byte', async () => {
        const subject = 'Saved conversation';
        const raw = message(subject);

        const res = await importRequest(alice, raw);
        const { id } = await assertJson<ImportMailResult>(res);
        expect(id).toBeTruthy();

        const summary = (await inbox(alice)).find((m) => m.id === id);
        expect(summary?.subject).toBe(subject);
        expect(summary?.isRead).toBe(false);
        expect(summary?.mailbox).toBe('');

        const messageRes = await authedRequest(alice.sessionToken, `/mail/${alice.id}/message/${id}`);
        expect((await assertJson<Email>(messageRes)).text).toContain('Saved from another client.');

        const downloadRes = await authedRequest(alice.sessionToken, `/mail/${alice.id}/message/${id}/download`);
        expect(downloadRes.status).toBe(200);
        expect(new Uint8Array(await downloadRes.arrayBuffer())).toEqual(new TextEncoder().encode(raw));
    });

    test('an import raises no new-mail notification, while a delivery still does', async () => {
        const user = await createTestUser('eml-import-notify@test.eigen.is', PASSWORD, 'Eml Import Notify');

        const { id } = await assertJson<ImportMailResult>(await importRequest(user, message('Imported quietly')));
        expect((await inbox(user)).some((m) => m.id === id)).toBe(true);
        expect(await newMailNotifications(user)).toEqual([]);

        expect((await deliver(user.email, message('Delivered loudly'))).status).toBe(200);
        expect((await newMailNotifications(user)).length).toBe(1);
    });

    test('an invitation inside an imported file creates no calendar event', async () => {
        const uid = `imported-invite-${randomUUID()}@external.com`;
        const boundary = 'eml-import-invite';
        const raw = [
            'From: organizer@external.com',
            // The DKIM verdict OpenDKIM prepended when this message was first delivered somewhere else:
            // the delivery path would act on it, so only the import path's own rule keeps the calendar clean.
            `Authentication-Results: ${getMailDomain()}; dkim=pass header.d=external.com`,
            `To: ${alice.email}`,
            'Subject: Invitation: Imported Lunch',
            'Date: Mon, 20 Apr 2026 10:00:00 +0000',
            'MIME-Version: 1.0',
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain',
            '',
            'You have been invited.',
            `--${boundary}`,
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8',
            'Content-Disposition: attachment; filename="invite.ics"',
            '',
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//External//Calendar//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:Imported Lunch',
            'DTSTART:20260420T120000Z',
            'DTEND:20260420T130000Z',
            'ORGANIZER;CN="External Org":mailto:organizer@external.com',
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${alice.email}`,
            'END:VEVENT',
            'END:VCALENDAR',
            `--${boundary}--`,
        ].join('\r\n');

        const res = await importRequest(alice, raw);
        expect(res.status).toBe(200);

        const from = Math.floor(new Date('2026-04-19').getTime() / 1000);
        const to = Math.floor(new Date('2026-04-21').getTime() / 1000);
        const eventsRes = await authedRequest(alice.sessionToken, `/calendar/${alice.id}/event-range/${from}/${to}`);
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        expect(events.some((e) => e.uid === uid)).toBe(false);
    });

    test('the same file imported twice gives two messages, as an IMAP APPEND would', async () => {
        const subject = `Twice over ${randomUUID()}`;
        const raw = message(subject);

        expect((await importRequest(alice, raw)).status).toBe(200);
        expect((await importRequest(alice, raw)).status).toBe(200);

        expect((await inbox(alice)).filter((m) => m.subject === subject).length).toBe(2);
    });

    // An editor that saves an .eml as UTF-8 can put a BOM in front of the headers; the first one is the
    // envelope header the import gate reads, so losing it turns a valid message into a 400.
    test('a message saved with a UTF-8 BOM imports and keeps its sender', async () => {
        const raw = ['From: Ada Lovelace <ada@eml-import.example>', 'Content-Type: text/plain', '', 'Bom.'].join(
            '\r\n',
        );
        const body = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode(raw)]);

        const { id } = await assertJson<ImportMailResult>(await importRequest(alice, body));
        expect(findOrFail(await inbox(alice), (m) => m.id === id).fromAddress).toBe('ada@eml-import.example');
    });

    test('a file that is not a message is 400 and nothing is written', async () => {
        const before = (await inbox(alice)).length;

        const res = await importRequest(alice, 'not a message, just some bytes\r\n');
        expect(res.status).toBe(400);
        expect((await inbox(alice)).length).toBe(before);
    });

    test('a body over EML_MAX_BYTES is 413 before the body is read', async () => {
        // The body is not a message (a 400 if it were ever parsed), so a 413 can only come from the
        // Content-Length check that runs first.
        const res = await importRequest(alice, new Blob([new TextEncoder().encode('From: a@b.c\r\n')]), {
            'Content-Length': String(EML_MAX_BYTES + 1),
        });
        expect(res.status).toBe(413);
    });

    test('import-from-drive on own drive imports the file as a message', async () => {
        const subject = `From Drive ${randomUUID()}`;
        const uploaded = await uploadEml(message(subject));

        const res = await importFromDrive(alice, uploaded);
        const { id } = await assertJson<ImportMailResult>(res);

        expect((await inbox(alice)).find((m) => m.id === id)?.subject).toBe(subject);
    });

    // The whole message parses and indexes before the route answers, so it exempts itself from the
    // server-wide idle timeout the way the raw import and both contacts imports do.
    test('import-from-drive exempts its request from the idle timeout', async () => {
        const uploaded = await uploadEml(message(`Timeout ${randomUUID()}`));
        // app.handle() runs with no server, so the route's `server?.timeout` is a no-op in tests: give the
        // app a real one to observe the call, and take it away again.
        const server = Bun.serve({ port: 0, fetch: () => new Response('') });
        app.server = server;
        const timeout = spyOn(server, 'timeout');
        try {
            expect((await importFromDrive(alice, uploaded)).status).toBe(200);
            expect(timeout.mock.calls.map(([, seconds]) => seconds)).toEqual([0]);
        } finally {
            timeout.mockRestore();
            app.server = null;
            server.stop(true);
        }
    });

    test('import-from-drive on a file that is not an .eml is 400', async () => {
        const file = new File([new TextEncoder().encode(message('Mislabeled'))], 'notes.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(400);
    });

    test('import-from-drive on a folder named like a message is 400', async () => {
        const folder = await drivePost<DrivePath>(alice.sessionToken, alice.id, mountId, `folder/${rootId}`, {
            folderName: `folder-${randomUUID()}.eml`,
        });

        const res = await importFromDrive(alice, folder);
        expect(res.status).toBe(400);
    });

    test('import-from-drive is 413 when the file outgrew the size its row claims', async () => {
        const uploaded = await uploadEml(message('Grew after the check'), `grew-${randomUUID()}.eml`);
        const mount = findOrFail((await getHome(alice.id)).drive.getMounts(), (m) => m.id === mountId);
        await mount.storage.write(await mount.getStorageKey(uploaded.id), Buffer.alloc(EML_MAX_BYTES + 1, 0x41));

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(413);
    });

    test("import-from-drive on bob's unshared file is 403", async () => {
        const file = new File([new TextEncoder().encode(message('Bob private'))], 'bob.eml', { type: EML_MIME });
        const uploaded = await driveUpload(bob.sessionToken, bob.id, bobMountId, bobRootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(403);
    });

    test("bob cannot import into alice's mailbox", async () => {
        const res = await authedRequest(bob.sessionToken, `/mail/${alice.id}/import`, {
            method: 'POST',
            headers: { 'Content-Type': EML_MIME },
            body: message('Mallory'),
        });
        expect(res.status).toBe(403);
    });

    test('a guest is refused on both import routes', async () => {
        const raw = await authedRequest(guestToken, `/mail/${guestId}/import`, {
            method: 'POST',
            headers: { 'Content-Type': EML_MIME },
            body: message('Guest'),
        });
        expect(raw.status).toBe(403);

        const fromDrive = await authedRequest(guestToken, `/mail/${guestId}/import-from-drive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceOwnerId: alice.id, sourceMountId: mountId, sourcePathId: rootId }),
        });
        expect(fromDrive.status).toBe(403);
    });

    test('an import over the mail + contacts quota is 507 and nothing is written', async () => {
        const MB = 1024 * 1024;
        const user = await createTestUser('eml-import-quota@test.eigen.is', PASSWORD, 'Eml Import Quota');
        const home = await getHome(user.id);
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

        try {
            const used = (await home.mail.size()) + (await home.contacts.size());
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.floor(used / MB) } });

            const before = (await inbox(user)).length;
            const res = await importRequest(user, message('Over quota'));
            expect(res.status).toBe(507);
            expect((await inbox(user)).length).toBe(before);
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });
});
