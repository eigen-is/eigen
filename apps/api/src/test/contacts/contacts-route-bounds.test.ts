// A REST bound is never tighter than what a CardDAV PUT may store: the per-resource byte ceiling is the real
// bound, and anything below it would make a card a device wrote uneditable in the web app forever.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { davRequest } from '../dav-test-helpers';
import { assertJson, authedRequest, createTestUser, findOrFail, getTestContext, type TestUser } from '../setup';

const LONG_TEXT = 'x'.repeat(713);

describe('the REST contact bounds against what a CardDAV PUT stores', () => {
    let user: TestUser;
    let stored: Contact;

    // The reviewer's card: every free-text value past 512 characters and more addresses than the REST array took.
    const emails = Array.from({ length: 150 }, (_, i) => `EMAIL;TYPE=INTERNET:box${i}@example.com`);
    // One address longer than any address grammar allows: a card's EMAIL is stored as the card spells it.
    emails.push(`EMAIL;TYPE=INTERNET:${'l'.repeat(300)}@example.com`);

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('card-bounds@test.eigen.is', 'testpassword123', 'Card Bounds');

        const put = await davRequest('PUT', `/dav/addressbooks/${user.id}/contacts/wide-card.vcf`, {
            email: user.email,
            headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' },
            body: `${[
                'BEGIN:VCARD',
                'VERSION:3.0',
                'UID:wide-card@device',
                `N:${LONG_TEXT};${LONG_TEXT};;;`,
                `FN:${LONG_TEXT} ${LONG_TEXT}`,
                `ORG:${LONG_TEXT}`,
                `TITLE:${LONG_TEXT}`,
                `NOTE:${LONG_TEXT}`,
                `CATEGORIES:${LONG_TEXT}`,
                ...emails,
                'END:VCARD',
            ].join('\r\n')}\r\n`,
        });
        expect(put.status).toBe(201);

        stored = findOrFail(
            await assertJson<Contact[]>(await authedRequest(user.sessionToken, `/contacts/${user.id}/contacts`)),
            (c) => c.company === LONG_TEXT,
        );
    });

    test('a device card the web app cannot re-save is not a thing', async () => {
        expect(stored.firstName.length).toBe(713);
        expect(stored.lastName.length).toBe(713);
        expect(stored.jobTitle?.length).toBe(713);
        expect(stored.notes?.length).toBe(713);
        expect(stored.email).toHaveLength(151);
        expect(stored.email.at(-1)?.length).toBe(312);

        // The web app's own save: the card as the form loaded it, with one field edited.
        const res = await authedRequest(user.sessionToken, `/contacts/${user.id}/contacts/${stored.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...stored, notes: 'Edited in the web app' }),
        });
        expect(res.status).toBe(200);

        const saved = await assertJson<Contact>(
            await authedRequest(user.sessionToken, `/contacts/${user.id}/contacts/${stored.id}`),
        );
        expect(saved.notes).toBe('Edited in the web app');
        expect(saved.firstName).toBe(stored.firstName);
        expect(saved.company).toBe(LONG_TEXT);
        expect(saved.jobTitle).toBe(LONG_TEXT);
        expect(saved.email).toHaveLength(151);
    });

    test('a label the card minted from its CATEGORIES is editable in the web app', async () => {
        const label = findOrFail(
            await assertJson<Label[]>(await authedRequest(user.sessionToken, `/contacts/${user.id}/labels`)),
            (l) => l.name === LONG_TEXT,
        );
        const res = await authedRequest(user.sessionToken, `/contacts/${user.id}/labels/${label.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...label, color: '#ff0000' }),
        });
        expect(await assertJson<Label>(res)).toEqual({ id: label.id, name: LONG_TEXT, color: '#ff0000' });
    });
});
