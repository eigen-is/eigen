import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { type DrivePath, VCARD_MIMES } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { splitVCards } from '../../lib/vcard';
import {
    app,
    assertJson,
    authedRequest,
    createTestUser,
    driveGet,
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
    type TestUser,
} from '../setup';
import { importFromDriveRequest, importRaw } from '../transfer-test-helpers';

const PASSWORD = 'testpassword123';

// LF-terminated 3.0 cards, the way every desktop client writes an export.
const card = (fn: string, email: string, uid: string = randomUUID()) =>
    `${[
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${uid}`,
        `N:${fn.split(' ')[1] ?? ''};${fn.split(' ')[0]};;;`,
        `FN:${fn}`,
        `EMAIL;TYPE=INTERNET:${email}`,
        'END:VCARD',
    ].join('\n')}\n`;

// Own users, never the shared ctx book: other contacts tests populate that one in a file order that
// differs between macOS and CI, and the import counts here are exact.
describe('Contacts transfer routes', () => {
    let alice: TestUser;
    let bob: TestUser;
    let mountId: string;
    let rootId: string;
    let bobMountId: string;
    let bobRootId: string;

    const exportRequest = (user: TestUser, ownerId: string, body: { ids?: string[] }) =>
        authedRequest(user.sessionToken, `/contacts/${ownerId}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    const importRequest = (user: TestUser, body: BodyInit, headers: Record<string, string> = {}) =>
        importRaw(user, 'contacts', VCARD_MIMES[0], body, { headers });

    const importFromDrive = (user: TestUser, source: DrivePath) => importFromDriveRequest(user, 'contacts', source);

    const createContact = async (firstName: string, lastName: string, email: string): Promise<string> => {
        const res = await authedRequest(alice.sessionToken, `/contacts/${alice.id}/contacts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName, lastName, email: [email], phone: [] }),
        });
        expect(res.status).toBe(200);
        const id = await res.text();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        return id;
    };

    beforeAll(async () => {
        await getTestContext();
        alice = await createTestUser('vcard-routes-alice@test.eigen.is', PASSWORD, 'VCard Routes Alice');
        bob = await createTestUser('vcard-routes-bob@test.eigen.is', PASSWORD, 'VCard Routes Bob');

        mountId = await firstMountId(alice.sessionToken, alice.id);
        rootId = (await driveGet(alice.sessionToken, alice.id, mountId, 'root')).id;
        bobMountId = await firstMountId(bob.sessionToken, bob.id);
        bobRootId = (await driveGet(bob.sessionToken, bob.id, bobMountId, 'root')).id;
    });

    test('export one contact names the file after FN', async () => {
        const id = await createContact('Ada', 'Lovelace', 'ada@vcard-routes.example');

        const res = await exportRequest(alice, alice.id, { ids: [id] });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/vcard');
        expect(res.headers.get('content-disposition')).toContain('Ada Lovelace.vcf');
        expect(await res.text()).toContain('FN:Ada Lovelace');
    });

    test('export many names the file contacts.vcf', async () => {
        const first = await createContact('Grace', 'Hopper', 'grace@vcard-routes.example');
        const second = await createContact('Alan', 'Turing', 'alan@vcard-routes.example');

        const res = await exportRequest(alice, alice.id, { ids: [first, second] });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toContain('contacts.vcf');
        expect(splitVCards(await res.text()).length).toBe(2);
    });

    test('export without ids returns the whole book as contacts.vcf', async () => {
        const res = await exportRequest(alice, alice.id, {});
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toContain('contacts.vcf');
        expect(splitVCards(await res.text()).length).toBeGreaterThan(1);
    });

    test('raw import returns counts', async () => {
        const text =
            card('Edsger Dijkstra', 'edsger@vcard-routes.example') +
            card('Barbara Liskov', 'barbara@vcard-routes.example');

        const res = await importRequest(alice, text);
        expect(await assertJson<ImportCountsResult>(res)).toEqual({ imported: 2, skipped: 0, failed: 0 });
    });

    test('raw import over VCARD_MAX_BYTES is 413 before the body is read', async () => {
        // The body is a fragment no importer would accept (a 400 if it were ever parsed), so a 413
        // can only come from the Content-Length check that runs first.
        const res = await importRequest(alice, new Blob([new TextEncoder().encode('BEGIN:VCARD\r\n')]), {
            'Content-Length': String(VCARD_MAX_BYTES + 1),
        });
        expect(res.status).toBe(413);
    });

    test('a raw import that is not UTF-8 is refused, not stored with mangled names', async () => {
        // 0xE9 is "é" in Windows-1252 and an invalid UTF-8 byte — the exact shape of an older client's export.
        const head = new TextEncoder().encode('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ren');
        const tail = new TextEncoder().encode('e\r\nEND:VCARD\r\n');
        const bytes = new Uint8Array([...head, 0xe9, ...tail]);

        const res = await importRequest(alice, new Blob([bytes]));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('UTF-8');
    });

    test('a long FN cannot fill the export filename header', async () => {
        const id = await createContact('L'.repeat(300), 'Long', 'long@vcard-routes.example');

        const res = await exportRequest(alice, alice.id, { ids: [id] });
        const disposition = res.headers.get('content-disposition') ?? '';
        expect(res.status).toBe(200);
        expect(disposition).toContain('.vcf');
        expect(disposition.length).toBeLessThan(300);
    });

    test('import-from-drive on own drive imports', async () => {
        const text =
            card('Ken Thompson', 'ken@vcard-routes.example') + card('Dennis Ritchie', 'dennis@vcard-routes.example');
        const file = new File([new TextEncoder().encode(text)], 'book.vcf', { type: 'text/vcard' });
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(await assertJson<ImportCountsResult>(res)).toEqual({ imported: 2, skipped: 0, failed: 0 });
    });

    test('import-from-drive on a .txt is 400', async () => {
        // vCard bytes under a .txt name: the file-type gate answers before anything is read.
        const file = new File(
            [new TextEncoder().encode(card('Jean Bartik', 'jean@vcard-routes.example'))],
            'notes.txt',
            {
                type: 'text/plain',
            },
        );
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(400);
    });

    test('import-from-drive on a file that is not UTF-8 is refused the same way', async () => {
        const head = new TextEncoder().encode('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ren');
        const tail = new TextEncoder().encode('e\r\nEND:VCARD\r\n');
        const file = new File([new Uint8Array([...head, 0xe9, ...tail])], 'latin1.vcf', { type: 'text/vcard' });
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('UTF-8');
    });

    test('import-from-drive on a folder named like a vCard is 400', async () => {
        const folder = await drivePost<DrivePath>(alice.sessionToken, alice.id, mountId, `folder/${rootId}`, {
            folderName: `folder-${randomUUID()}.vcf`,
        });

        const res = await importFromDrive(alice, folder);
        expect(res.status).toBe(400);
    });

    test("import-from-drive on bob's unshared file is 403", async () => {
        const file = new File(
            [new TextEncoder().encode(card('Bob Private', 'bob-private@vcard-routes.example'))],
            'bob.vcf',
            {
                type: 'text/vcard',
            },
        );
        const uploaded = await driveUpload(bob.sessionToken, bob.id, bobMountId, bobRootId, file);

        const res = await importFromDrive(alice, uploaded);
        expect(res.status).toBe(403);
    });

    test("bob cannot export alice's contacts", async () => {
        const res = await exportRequest(bob, alice.id, {});
        expect(res.status).toBe(403);
    });

    test("bob cannot import into alice's book", async () => {
        const res = await authedRequest(bob.sessionToken, `/contacts/${alice.id}/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/vcard' },
            body: card('Mallory Intruder', 'mallory@vcard-routes.example'),
        });
        expect(res.status).toBe(403);
    });

    test('a two-card DAV PUT is still rejected with 400', async () => {
        const body =
            card('Ada Second', 'ada-second@vcard-routes.example') +
            card('Bob Second', 'bob-second@vcard-routes.example');
        const res = await app.handle(
            new Request(`http://localhost/dav/addressbooks/${alice.id}/contacts/${randomUUID()}.vcf`, {
                method: 'PUT',
                headers: {
                    Authorization: `Basic ${btoa(`${alice.email}:${PASSWORD}`)}`,
                    'Content-Type': 'text/vcard; charset=utf-8',
                    'If-None-Match': '*',
                },
                body,
            }),
        );
        expect(res.status).toBe(400);
    });
});
