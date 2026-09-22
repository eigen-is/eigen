import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import type { Contacts } from '../../lib/contacts/contacts';
import * as contactsSchema from '../../lib/contacts/schema';
import { CONTACTS_TEST_ROOT, cardTextOf, makeContacts, stageAvatar, validContact } from '../contacts-test-helpers';
import { ensureServer } from '../setup';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

const rowOf = (db: Contacts['db'], id: string) =>
    db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

// The one failure a blob write has left: the transaction carrying it rolls back. The throw goes inside the
// callback, so SQLite really does undo the statements — a throw before it would prove nothing. Returns the undo.
function breakTransaction(contacts: Contacts): () => void {
    const db = contacts.db as unknown as { transaction: (cb: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = (cb) =>
        original.call(db, (tx: unknown) => {
            cb(tx);
            throw new Error('transaction boom');
        });
    return () => {
        db.transaction = original;
    };
}

describe('a write that does not commit', () => {
    test('an update whose transaction throws leaves the previous bytes, etag and byte count', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const id = await contacts.addContact(validContact({ firstName: 'Before', email: ['before@example.com'] }));
        const before = rowOf(db, id);
        const bytesBefore = await contacts.size();
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        const restore = breakTransaction(contacts);
        try {
            await expect(
                contacts.updateContact(
                    id,
                    validContact({ firstName: 'After', email: ['before@example.com'], notes: 'never committed' }),
                ),
            ).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        // The stored bytes are the resource: a failed write hands the reader the previous ones, unchanged.
        expect(await cardTextOf(contacts, before.uri)).not.toContain('never committed');
        expect((await contacts.getCard(before.uri))!.etag).toBe(before.etag);
        expect(rowOf(db, id)).toEqual(before);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
        // The delta is applied only once the transaction returns, so a rollback leaves no drift.
        expect(await contacts.size()).toBe(bytesBefore);
    });

    test('a create whose transaction throws stores no row and no blob', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const before = db.select().from(contactsSchema.contacts).all().length;
        const bytesBefore = await contacts.size();

        const restore = breakTransaction(contacts);
        try {
            await expect(
                contacts.addContact(validContact({ firstName: 'Orphan', email: ['orphan@example.com'] })),
            ).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(db.select().from(contactsSchema.contacts).all().length).toBe(before);
        expect((await contacts.getContacts()).some((c) => c.firstName === 'Orphan')).toBe(false);
        expect(await contacts.size()).toBe(bytesBefore);
    });
});

describe('the book row at init', () => {
    const syncGenOf = (contacts: Contacts) =>
        contacts.db.select().from(contactsSchema.book).where(eq(contactsSchema.book.id, 1)).get()!.syncGen;

    test('is minted under a clock-seeded syncGen, and a later book gets its own', async () => {
        const seconds = Math.floor(Date.now() / 1000);
        const { instance: contacts } = await makeContacts();
        expect(syncGenOf(contacts)).toBeGreaterThanOrEqual(seconds);

        // A book recreated after a loss must never reissue a generation a client has already seen, so the
        // clock — not a constant — decides it: a later book is minted above every token the first one signed.
        const ticked = spyOn(Date, 'now').mockReturnValue((seconds + 5) * 1000);
        try {
            const { instance: later } = await makeContacts();
            expect(syncGenOf(later)).toBe(seconds + 5);
        } finally {
            ticked.mockRestore();
        }
    });
});

describe('rebuildProjection', () => {
    test('every projected column and the junction come back from the blobs', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const labelId = await contacts.addLabel({ name: 'Rebuilt', color: '#abcdef' });
        const withPhoto = await contacts.addContact(
            validContact({ firstName: 'Photo', avatar: await stageAvatar(contacts), labels: [labelId] }),
        );
        const plain = await contacts.addContact(validContact({ firstName: 'Plain', email: ['plain@example.com'] }));
        const before = [rowOf(db, withPhoto), rowOf(db, plain)];
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        const linksBefore = db.select().from(contactsSchema.contactsToLabels).all();
        expect(linksBefore.length).toBeGreaterThan(0);

        // Corrupt every column the blob decides, plus the junction. `data.avatar` is the derived cache URL,
        // which no blob carries, so it stays as it is.
        for (const row of before) {
            db.update(contactsSchema.contacts)
                .set({
                    uid: `corrupt-${row.id}`,
                    firstName: 'corrupt',
                    lastName: 'corrupt',
                    isGroup: true,
                    data: { email: [], phone: [], avatar: row.data?.avatar ?? '' },
                    etag: 'corrupt',
                })
                .where(eq(contactsSchema.contacts.id, row.id))
                .run();
        }
        db.delete(contactsSchema.contactsToLabels).run();

        contacts.rebuildProjection();

        for (const row of before) expect(rowOf(db, row.id)).toEqual(row);
        expect(db.select().from(contactsSchema.contactsToLabels).all()).toEqual(linksBefore);
        // A rebuild is not a change: no ctag moves, so no client is told to resync.
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
    });
});

describe('deleting a contact', () => {
    test('a delete removes the row and its blob, and tombstones the uri, in one transaction', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const id = await contacts.addContact(validContact({ firstName: 'Doomed', email: ['doomed@example.com'] }));
        const row = rowOf(db, id);
        const bytesBefore = await contacts.size();

        await contacts.deleteContact(id);

        expect(await contacts.getCard(row.uri)).toBeNull();
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get(),
        ).toBeUndefined();
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, row.uri))
                .get(),
        ).toBeTruthy();
        expect(await contacts.size()).toBe(bytesBefore - row.vcard.byteLength);
    });

    test('a delete whose transaction throws leaves the row, ctag, tombstones and bytes untouched', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const id = await contacts.addContact(validContact({ firstName: 'Keep', email: ['keep@example.com'] }));
        const row = rowOf(db, id);
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        const tombstonesBefore = db.select().from(contactsSchema.contactTombstones).all();
        const bytesBefore = await contacts.size();

        const restore = breakTransaction(contacts);
        try {
            await expect(contacts.deleteContact(id)).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(await contacts.getCard(row.uri)).not.toBeNull();
        expect(rowOf(db, id)).toEqual(row);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
        expect(db.select().from(contactsSchema.contactTombstones).all()).toEqual(tombstonesBefore);
        expect(await contacts.size()).toBe(bytesBefore);
    });

    test('a second delete of the same contact is a no-op, not a second tombstone', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const id = await contacts.addContact(validContact({ firstName: 'Gone', email: ['gone@example.com'] }));
        const row = rowOf(db, id);

        await contacts.deleteContact(id);
        const ctagAfterDelete = db.select().from(contactsSchema.book).get()!.ctag;
        const tombstone = db
            .select()
            .from(contactsSchema.contactTombstones)
            .where(eq(contactsSchema.contactTombstones.uri, row.uri))
            .get()!;

        // REST delete is idempotent, unlike the DAV one: an unknown id changes nothing at all.
        await contacts.deleteContact(id);

        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagAfterDelete);
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, row.uri))
                .get(),
        ).toEqual(tombstone);
    });
});

// The app sends birthdays as bare dates; the seam also normalizes external ISO datetime input so the stored
// bytes stay the source of truth and echoing a phone's BDAY remains a no-op.
describe('birthday normalization at the seam', () => {
    test('addContact stores a date-only birthday as a date BDAY and round-trips it', async () => {
        const { instance: contacts } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Born', email: ['born@example.com'], birthday: '1990-01-01' }),
        );

        expect(await cardTextOf(contacts, `${id}.vcf`)).toContain('BDAY:1990-01-01');
        expect((await contacts.getContactById(id))?.birthday).toBe('1990-01-01');
    });

    test('external ISO input keeps its date prefix verbatim instead of shifting by timezone', async () => {
        const { instance: contacts } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Eve', email: ['eve@example.com'], birthday: '1989-12-31T22:00:00.000Z' }),
        );

        expect(await cardTextOf(contacts, `${id}.vcf`)).toContain('BDAY:1989-12-31');
        expect((await contacts.getContactById(id))?.birthday).toBe('1989-12-31');
    });

    test('updateContact echoing a phone-synced BDAY leaves the BDAY line untouched', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const cardId = randomUUID();
        const uri = 'phone.vcf';
        const put = await contacts.putCard(
            uri,
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${cardId}\r\nN:Sync;Phone;;;\r\nFN:Phone Sync\r\nEMAIL:phone@example.com\r\nBDAY:19731003\r\nEND:VCARD\r\n`,
            { ifMatch: null, ifNoneMatch: '*' },
        );
        expect(put.ok).toBe(true);
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.uri, uri)).get()!;
        expect((await contacts.getContactById(row.id))?.birthday).toBe('1973-10-03');

        // The app echoes the bare-date projection; the phone's compact BDAY must survive byte-for-byte.
        await contacts.updateContact(row.id, {
            firstName: 'Phone',
            lastName: 'Sync',
            email: ['phone@example.com'],
            phone: [],
            birthday: '1973-10-03',
            labels: [],
        });

        expect(await cardTextOf(contacts, uri)).toContain('BDAY:19731003');
    });
});

// Renaming yourself in Contacts also renames you org-wide, but that push happens after the card is committed:
// it may never turn a saved edit into a reported failure.
describe('self-profile propagation', () => {
    test('a failed profile push still reports the committed self-card edit as saved', async () => {
        const { instance: contacts, broadcasts, user } = await makeContacts();
        const db = contacts.db;
        const me = (await contacts.getMe())!;
        const before = rowOf(db, me.id);

        const relay = await import('../../lib/home/home-relay');
        let pushed = false;
        const push = spyOn(relay, 'pushUserProfile').mockImplementation(async () => {
            pushed = true;
            throw new Error('push boom');
        });
        const origError = console.error;
        console.error = () => {};
        broadcasts.length = 0;

        try {
            await contacts.updateContact(
                me.id,
                validContact({
                    firstName: 'Augusta',
                    lastName: 'King',
                    email: [user.email],
                    notes: 'propagation failed',
                }),
            );
        } finally {
            push.mockRestore();
            console.error = origError;
        }

        expect(pushed).toBe(true);
        // The card committed before the push ran, so the client must be told it did — a reported failure
        // would send the next save back with a stale etag that 412s.
        expect(await cardTextOf(contacts, before.uri)).toContain('NOTE:propagation failed');
        const after = rowOf(db, me.id);
        expect(after.firstName).toBe('Augusta');
        expect(after.etag).not.toBe(before.etag);
        expect((await contacts.getContactById(me.id))?.notes).toBe('propagation failed');
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(true);
    });
});

// Seeding the org owner into a fresh book is one-shot, latched in book.ownerSeeded once a real owner has been
// considered — and only then, so an instance that has no owner yet still seeds the one it gets later.
describe('owner-contact seeding (one-shot latch)', () => {
    // getOrgOwner resolves the admin created by the setup wizard.
    beforeAll(async () => {
        await ensureServer();
    });
    const ownerSeededFlag = (db: Contacts['db']) =>
        db.select().from(contactsSchema.book).where(eq(contactsSchema.book.id, 1)).get()!.ownerSeeded;

    test('a deleted owner contact stays deleted across a re-init', async () => {
        const { getOrgOwner } = await import('../../lib/user/user');
        const owner = (await getOrgOwner())!;
        const setting = getServerSettings().onboarding.autoAddOwnerContact;
        await updateServerSettings({ onboarding: { autoAddOwnerContact: true } });

        try {
            const { instance: contacts } = await makeContacts();
            const db = contacts.db;
            const seeded = (await contacts.getContacts()).find((c) => c.email.includes(owner.email))!;
            expect(seeded).toBeTruthy();
            expect(ownerSeededFlag(db)).toBe(1);

            await contacts.deleteContact(seeded.id);
            await contacts.init();

            // The latch outlives the card: the user meant to remove it, so no init may put it back.
            expect((await contacts.getContacts()).some((c) => c.email.includes(owner.email))).toBe(false);
        } finally {
            await updateServerSettings({ onboarding: { autoAddOwnerContact: setting } });
        }
    });

    test('an owner configured only later still seeds exactly once', async () => {
        const userModule = await import('../../lib/user/user');
        const owner = (await userModule.getOrgOwner())!;
        let configured = false;
        const lookup = spyOn(userModule, 'getOrgOwner').mockImplementation(async () => (configured ? owner : null));
        const setting = getServerSettings().onboarding.autoAddOwnerContact;
        await updateServerSettings({ onboarding: { autoAddOwnerContact: true } });

        try {
            // No owner to consider yet — nothing is seeded and the latch must stay open.
            const { instance: contacts } = await makeContacts();
            const db = contacts.db;
            expect((await contacts.getContacts()).some((c) => c.email.includes(owner.email))).toBe(false);
            expect(ownerSeededFlag(db)).toBe(0);

            configured = true;
            await contacts.init();
            await contacts.init();

            expect((await contacts.getContacts()).filter((c) => c.email.includes(owner.email)).length).toBe(1);
            expect(ownerSeededFlag(db)).toBe(1);
        } finally {
            lookup.mockRestore();
            await updateServerSettings({ onboarding: { autoAddOwnerContact: setting } });
        }
    });
});
