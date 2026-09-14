import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import { parseVCard, splitVCards } from '../../lib/vcard';
import { CONTACTS_TEST_ROOT, makeContacts, stageAvatar, validContact } from '../contacts-test-helpers';
import { createTestUser, getTestContext } from '../setup';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

// The fixtures are built as text, LF-terminated, the way every desktop client writes an export — the
// importer's own transcode/normalization is what the tests are pinning.
const card30 = (fn: string, email: string, uid?: string, extra: string[] = []) =>
    `${[
        'BEGIN:VCARD',
        'VERSION:3.0',
        ...(uid ? [`UID:${uid}`] : []),
        `N:${fn.split(' ')[1] ?? ''};${fn.split(' ')[0]};;;`,
        `FN:${fn}`,
        `EMAIL;TYPE=INTERNET:${email}`,
        ...extra,
        'END:VCARD',
    ].join('\n')}\n`;

// A 1×1 PNG as a 4.0 data: URI PHOTO, plus the ISO-basic BDAY only 4.0 writes.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const card40 = (fn: string, email: string, uid: string) =>
    `${[
        'BEGIN:VCARD',
        'VERSION:4.0',
        `UID:${uid}`,
        `N:${fn.split(' ')[1] ?? ''};${fn.split(' ')[0]};;;`,
        `FN:${fn}`,
        `EMAIL:${email}`,
        'BDAY:19061209',
        `PHOTO:data:image/png;base64,${PNG_1X1}`,
        'END:VCARD',
    ].join('\n')}\n`;

describe('Contacts export', () => {
    test('export of two ids returns two cards in id order, FN and PHOTO preserved', async () => {
        const { contacts } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const a = await contacts.addContact(validContact({ firstName: 'Ada', avatar: staged }));
        const b = await contacts.addContact(validContact({ firstName: 'Bob', email: ['bob@example.com'] }));

        const text = await contacts.exportCards([b, a]);
        const cards = splitVCards(text).map((c) => parseVCard(c));

        expect(cards.map((c) => c.firstName)).toEqual(['Bob', 'Ada']);
        expect(cards[1].photo?.kind).toBe('inline');
        expect(text.endsWith('\r\n')).toBe(true);
        expect(text.includes('\r\n\r\n')).toBe(false);
    });

    test('export without ids returns the whole book, in getContacts order', async () => {
        const { contacts } = await makeContacts();
        await contacts.addContact(validContact({ firstName: 'Ada' }));
        await contacts.addContact(validContact({ firstName: 'Bob', email: ['bob@example.com'] }));

        const book = await contacts.getContacts();
        const cards = splitVCards(await contacts.exportCards()).map((c) => parseVCard(c));

        expect(cards.length).toBe(book.length);
        expect(cards.map((c) => c.firstName)).toEqual(book.map((c) => c.firstName));
    });

    test('export of an unknown id throws 404', async () => {
        const { contacts } = await makeContacts();
        await expect(contacts.exportCards([randomUUID()])).rejects.toMatchObject({ status: 404 });
    });
});

describe('Contacts import', () => {
    test('import three LF cards, one v4.0 with PHOTO, creates three rows', async () => {
        const { contacts } = await makeContacts();
        const before = (await contacts.getContacts()).length;
        const text =
            card30('Grace Hopper', 'grace@example.com', randomUUID()) +
            card30('Alan Turing', 'alan@example.com', randomUUID()) +
            card40('Ada Lovelace', 'ada@example.com', randomUUID());

        expect(await contacts.importCards(text)).toEqual({ imported: 3, skipped: 0, failed: 0 });

        const book = await contacts.getContacts();
        expect(book.length).toBe(before + 3);
        const ada = book.find((c) => c.firstName === 'Ada' && c.lastName === 'Lovelace' && c.birthday);
        expect(ada?.birthday).toBe('1906-12-09');
        expect(ada?.avatar).toMatch(/\.webp$/);
    });

    test('re-import skips all three by UID', async () => {
        const { contacts } = await makeContacts();
        const text =
            card30('Grace Hopper', 'grace@example.com', randomUUID()) +
            card30('Alan Turing', 'alan@example.com', randomUUID()) +
            card40('Ada Lovelace', 'ada@example.com', randomUUID());

        expect(await contacts.importCards(text)).toEqual({ imported: 3, skipped: 0, failed: 0 });
        expect(await contacts.importCards(text)).toEqual({ imported: 0, skipped: 3, failed: 0 });
    });

    test('same first email under a fresh UID is skipped, case and padding folded', async () => {
        const { contacts } = await makeContacts();
        await contacts.addContact(validContact({ firstName: 'Grace', email: ['grace@example.com'] }));

        const again = card30('Grace Hopper', '  GRACE@Example.COM  ', randomUUID());
        expect(await contacts.importCards(again)).toEqual({ imported: 0, skipped: 1, failed: 0 });
    });

    test('duplicate email inside one file imports once', async () => {
        const { contacts } = await makeContacts();
        const text =
            card30('Grace Hopper', 'grace@example.com', randomUUID()) +
            card30('Grace Hopper', 'grace@example.com', randomUUID());

        expect(await contacts.importCards(text)).toEqual({ imported: 1, skipped: 1, failed: 0 });
    });

    test('a KIND:group card is skipped', async () => {
        const { contacts } = await makeContacts();
        const text = card30('Colleagues', 'group@example.com', randomUUID(), ['X-ADDRESSBOOKSERVER-KIND:group']);

        expect(await contacts.importCards(text)).toEqual({ imported: 0, skipped: 1, failed: 0 });
    });

    test('a malformed card fails, the others import', async () => {
        const { contacts } = await makeContacts();
        const text =
            card30('Grace Hopper', 'grace@example.com', randomUUID()) +
            'BEGIN:VCARD\nVERSION:3.0\nthis line carries no colon\nEND:VCARD\n' +
            card30('Alan Turing', 'alan@example.com', randomUUID());

        expect(await contacts.importCards(text)).toEqual({ imported: 2, skipped: 0, failed: 1 });
    });

    // 'too-large' is the other failure putCard returns rather than throws: the card parses, then loses at the
    // CARD_MAX_BYTES gate, and lands in the same `failed` bucket as a parse error.
    test('a card over the card ceiling fails, the other imports', async () => {
        const { contacts } = await makeContacts();
        const text =
            card30('Grace Hopper', 'grace@example.com', randomUUID()) +
            card30('Fat Card', 'fat@example.com', randomUUID(), [`NOTE:${'n'.repeat(6 * 1024 * 1024)}`]);

        expect(await contacts.importCards(text)).toEqual({ imported: 1, skipped: 0, failed: 1 });
    });

    test('a card without UID imports with a minted UID', async () => {
        const { contacts } = await makeContacts();
        const before = new Set((await contacts.getContacts()).map((c) => c.id));

        expect(await contacts.importCards(card30('Grace Hopper', 'grace@example.com'))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 0,
        });

        const added = (await contacts.getContacts()).find((c) => !before.has(c.id))!;
        const card = parseVCard(await contacts.exportCards([added.id]));
        expect(card.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(card.firstName).toBe('Grace');
    });

    test('text that is not a vCard file throws 400', async () => {
        const { contacts } = await makeContacts();
        await expect(contacts.importCards('just some notes\n')).rejects.toMatchObject({ status: 400 });
    });

    test('more than IMPORT_MAX_CARDS throws 413', async () => {
        const { contacts } = await makeContacts();
        const text = Array.from({ length: IMPORT_MAX_CARDS + 1 }, (_, i) =>
            card30(`Card${i} Many`, `many-${i}@example.com`, randomUUID()),
        ).join('');

        await expect(contacts.importCards(text)).rejects.toMatchObject({ status: 413 });
    });
});

// makeContacts homes are deliberately unmetered (never registered, so atHome is false), so the quota result
// putCard returns is only reachable against a real registered home — the shape the CardDAV burst-cache test
// uses. Its own user keeps the squeezed ceiling away from the shared fixtures' books.
describe('Contacts import quota', () => {
    test('a quota refusal stops the import with a 507 naming the cards already committed', async () => {
        const MB = 1024 * 1024;
        await getTestContext();
        const user = await createTestUser('vcard-import@test.eigen.is', 'testpassword123', 'VCard Import');
        const home = await getHome(user.id);
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

        try {
            const used = (await home.mail.size()) + (await home.contacts.size());
            // Between 1 and 2 MB of headroom: the small card fits, the fat one (under CARD_MAX_BYTES, so it
            // reaches the quota gate rather than the size ceiling) cannot.
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.floor(used / MB) + 2 } });

            const text =
                card30('Small Card', 'small@example.com', randomUUID()) +
                card30('Fat Card', 'fat@example.com', randomUUID(), [`NOTE:${'n'.repeat(3 * MB)}`]);

            await expect(home.contacts.importCards(text)).rejects.toMatchObject({
                status: 507,
                message: 'Storage quota exceeded after importing 1 contacts',
            });

            // The card committed before the refusal stays.
            const book = await home.contacts.getContacts();
            expect(book.some((c) => c.firstName === 'Small')).toBe(true);
            expect(book.some((c) => c.firstName === 'Fat')).toBe(false);
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });
});
