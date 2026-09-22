import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import { avatarsDirOf } from '../contacts-test-helpers';
import { getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

// A card's vCard bytes are metered against the Home's one data budget, the same budget mail and calendar
// share. makeContacts homes are deliberately unmetered (never registered, so atHome is false), so every
// test here runs against a real registered Home, the only place putCard's quota gate runs.

// enforceHomeDataQuota's mail half is a live byte counter, so mail that arrives between two metered
// card writes is charged to the second one.
describe('CardDAV quota gate', () => {
    const burstCard = (i: number) => {
        const uid = randomUUID();
        const body = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nN:Burst;Card${i};;;\r\nFN:Card${i} Burst\r\nEMAIL:burst-${uid}@example.org\r\nEND:VCARD\r\n`;
        return { uri: `${uid}.vcf`, body };
    };

    test('a message delivered between two metered putCards is charged to the second', async () => {
        const MB = 1024 * 1024;
        const ctx = await getTestContext();
        const home = await getHome(ctx.bob.user.id);
        const contacts = home.contacts;
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

        const created: string[] = [];
        let deliveredId: string | undefined;
        try {
            // Headroom of at least 1 MB, so the card below fits and the 3 MB message below does not.
            const used = (await home.mail.size()) + (await home.contacts.size());
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.ceil(used / MB) + 1 } });

            const fits = burstCard(1);
            expect((await contacts.putCard(fits.uri, fits.body, { ifMatch: null, ifNoneMatch: null })).ok).toBe(true);
            created.push(fits.uri);

            deliveredId = await home.mail.mailboxDeliver(
                Buffer.from(
                    [
                        'From: sender@example.com',
                        `To: ${ctx.bob.user.email}`,
                        'Subject: Quota filler',
                        `Date: ${new Date().toUTCString()}`,
                        `Message-ID: <${Date.now()}.quota@test>`,
                        '',
                        'q'.repeat(3 * MB),
                    ].join('\r\n'),
                    'utf-8',
                ),
            );

            // The refusal is the typed 'quota' result (putCard's 507→'quota' mapping) and it comes on the very
            // next write: the budget the delivery took is gone the moment the index row exists.
            const over = burstCard(2);
            expect(await contacts.putCard(over.uri, over.body, { ifMatch: null, ifNoneMatch: null })).toEqual({
                ok: false,
                error: 'quota',
            });
            expect(await contacts.getCard(over.uri)).toBeNull();
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
            if (deliveredId) await home.mail.messageDelete(deliveredId);
            for (const uri of created) await contacts.deleteCard(uri, { ifMatch: null });
        }
    });
});

// A refusal must leave nothing behind, and the avatar cache is the one byte-costing side effect a card
// write still has: the ceilings run before the derivation, so a 507 writes no webp either.
describe('a refused write derives no avatar cache', () => {
    const MB = 1024 * 1024;

    // Below what the home already holds, so the very next card write is refused whatever its size.
    async function fillBudget(home: Awaited<ReturnType<typeof getHome>>): Promise<void> {
        await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.floor((await home.dataSize()) / MB) } });
    }

    test('a metered addContact over budget refuses before the staged photo is promoted', async () => {
        const ctx = await getTestContext();
        const home = await getHome(ctx.bob.user.id);
        const contacts = home.contacts;
        const avatarsDir = avatarsDirOf(join(TEST_DATA_DIR, 'home', ctx.bob.user.id));
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

        try {
            const staged = await contacts.uploadAvatar(new File([TEST_PNG_BYTES], 'avatar.png', { type: 'image/png' }));
            await fillBudget(home);
            const filesBefore = readdirSync(avatarsDir).sort();
            const avatarsBytesBefore = contacts.avatarsBytes;

            await expect(
                contacts.addContact({
                    firstName: 'Overflow',
                    lastName: 'Photo',
                    email: [`overflow-${randomUUID()}@example.org`],
                    phone: [],
                    avatar: staged,
                }),
            ).rejects.toThrow('Insufficient Storage');

            // Only the staged pair from the upload above: the promoted hash-named webp was never written.
            expect(readdirSync(avatarsDir).sort()).toEqual(filesBefore);
            expect(contacts.avatarsBytes).toBe(avatarsBytesBefore);
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });

    test('a metered PUT of a card with an inline photo refuses before the cache is derived', async () => {
        const ctx = await getTestContext();
        const home = await getHome(ctx.bob.user.id);
        const contacts = home.contacts;
        const avatarsDir = avatarsDirOf(join(TEST_DATA_DIR, 'home', ctx.bob.user.id));
        const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

        try {
            await fillBudget(home);
            const filesBefore = readdirSync(avatarsDir).sort();
            const avatarsBytesBefore = contacts.avatarsBytes;

            const uid = randomUUID();
            const body = [
                'BEGIN:VCARD',
                'VERSION:3.0',
                `UID:${uid}`,
                'N:Photo;Refused;;;',
                'FN:Refused Photo',
                `PHOTO;ENCODING=b;TYPE=PNG:${Buffer.from(TEST_PNG_BYTES).toString('base64')}`,
                'END:VCARD',
                '',
            ].join('\r\n');
            expect(await contacts.putCard(`${uid}.vcf`, body, { ifMatch: null, ifNoneMatch: null })).toEqual({
                ok: false,
                error: 'quota',
            });

            expect(await contacts.getCard(`${uid}.vcf`)).toBeNull();
            expect(readdirSync(avatarsDir).sort()).toEqual(filesBefore);
            expect(contacts.avatarsBytes).toBe(avatarsBytesBefore);
        } finally {
            await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
        }
    });
});
