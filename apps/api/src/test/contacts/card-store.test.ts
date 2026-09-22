import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { CARD_MAX_BYTES, labelColorFor, normalizeLabelName } from '../../lib/contacts/card-store';
import * as contactsSchema from '../../lib/contacts/schema';
import { computeResourceEtag, LocalFilesystem } from '../../lib/core';
import { createVCard, parseVCard } from '../../lib/vcard';
import { CONTACTS_TEST_ROOT, cardTextOf, makeContacts, validContact } from '../contacts-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-card-store-${Date.now()}`);
let counter = 0;
const nextStore = () => {
    const base = join(TEST_DIR, `store-${counter++}`);
    return { store: new LocalFilesystem(base), base };
};

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

describe('writeAtomic', () => {
    test('writes the exact bytes and leaves no temp file behind', async () => {
        const { store, base } = nextStore();
        const bytes = new TextEncoder().encode('BEGIN:VCARD\r\nEND:VCARD\r\n');
        await store.writeAtomic('cards/a.vcf', bytes);

        expect(new Uint8Array(await store.file('cards/a.vcf').arrayBuffer())).toEqual(bytes);
        expect(readdirSync(join(base, 'cards'))).toEqual(['a.vcf']);
    });

    test('overwrites an existing target atomically', async () => {
        const { store, base } = nextStore();
        await store.writeAtomic('cards/b.vcf', 'first');
        await store.writeAtomic('cards/b.vcf', 'second');

        expect(await store.file('cards/b.vcf').text()).toBe('second');
        expect(readdirSync(join(base, 'cards'))).toEqual(['b.vcf']);
    });

    test('fsyncs the parent directory, not just the temp file', async () => {
        // The bytes being on the platter is only half of it: the rename that publishes them lives in
        // the directory, so a power loss before the directory entry is flushed resurrects the OLD
        // file under an already-acknowledged write. Observed through FileHandle.sync — one fsync on
        // the temp file, then one on the directory it was renamed into.
        const { store } = nextStore();
        const probe = await open(TEST_DIR, 'r');
        const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
        await probe.close();

        const syncedADirectory: boolean[] = [];
        const realSync = handleProto.sync;
        const spy = spyOn(handleProto, 'sync').mockImplementation(async function (this: FileHandle) {
            syncedADirectory.push(fstatSync(this.fd).isDirectory());
            return realSync.call(this);
        });
        try {
            await store.writeAtomic('cards/c.vcf', 'durable');
        } finally {
            spy.mockRestore();
        }

        expect(syncedADirectory).toEqual([false, true]);
    });

    test('a failed write sweeps its temp file and rethrows the original error', async () => {
        // Force the temp-file fsync to throw mid-write: the staged temp must not leak (only the cards/ init
        // sweep self-heals its own leftovers), and the original error must surface. Reuses the shared
        // FileHandle.sync spy from the probe above.
        const { store, base } = nextStore();
        const probe = await open(TEST_DIR, 'r');
        const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
        await probe.close();

        const spy = spyOn(handleProto, 'sync').mockImplementation(async () => {
            throw new Error('fsync failed');
        });
        try {
            await expect(store.writeAtomic('cards/d.vcf', 'doomed')).rejects.toThrow('fsync failed');
        } finally {
            spy.mockRestore();
        }

        expect(readdirSync(join(base, 'cards'))).toEqual([]);
    });
});

describe('normalizeLabelName', () => {
    test('trims, lowercases and NFC-normalizes', () => {
        expect(normalizeLabelName('  Work  ')).toBe('work');
        // Decomposed "cafe" + combining acute, spelled in escapes so no editor can recompose it.
        expect(normalizeLabelName('Cafe\u0301')).toBe(normalizeLabelName('Caf\u00E9'));
        expect(normalizeLabelName('Cafe\u0301')).toBe('caf\u00E9');
    });
});

describe('labelColorFor', () => {
    test('is deterministic and lands in the accent palette', () => {
        const color = labelColorFor(normalizeLabelName('Work'));
        expect(color).toBe(labelColorFor(normalizeLabelName('Work')));
        expect(EIGEN_ACCENT_COLORS.some((c) => c.value === color)).toBe(true);
    });
});

// The search re-serializes a 5 MiB card ~23 times, so its result is memoized per target size and uid length
// (randomUUID is always 36 chars) — the exact-size check below still re-verifies it against the caller's uid.
const paddingCache = new Map<string, { notesLength: number; companyLength: number }>();

// The 5 MiB ceiling is a property of the assembled card, not of any single field, so a test that wants to
// sit exactly on it has to pad one: NOTE carries the bulk (folded, so its cost per character isn't 1) and a
// short ORG line — which never folds — tops the card up to the exact byte. createVCard is the same
// serializer addContact writes through, so the file it produces lands on the searched-for size.
function contactOfExactly(bytes: number, uid: string): CreateContactInput {
    const base = { firstName: 'Max', lastName: 'Bytes', email: [], phone: [] };
    const sizeOf = (notesLength: number, companyLength: number) =>
        new TextEncoder().encode(
            createVCard({ ...base, company: 'c'.repeat(companyLength), notes: 'n'.repeat(notesLength) }, uid),
        ).byteLength;

    const cacheKey = `${bytes}:${uid.length}`;
    let padding = paddingCache.get(cacheKey);
    if (!padding) {
        // Largest NOTE that still leaves room for the ORG top-up (its line is 'ORG:' + padding + CRLF).
        let low = 0;
        let high = bytes;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (sizeOf(mid, 0) <= bytes - 64) low = mid;
            else high = mid - 1;
        }
        padding = { notesLength: low, companyLength: bytes - sizeOf(low, 0) - 6 };
        paddingCache.set(cacheKey, padding);
    }

    const { notesLength, companyLength } = padding;
    if (sizeOf(notesLength, companyLength) !== bytes)
        throw new Error('could not build a card of exactly the target size');
    return { ...base, company: 'c'.repeat(companyLength), notes: 'n'.repeat(notesLength) };
}

// Whichever test warms the padding cache pays the ~23-probe serializer search; the default 5s leaves it no
// headroom on a machine loaded by the rest of the suite.
const CEILING_TIMEOUT_MS = 20_000;

describe('CARD_MAX_BYTES', () => {
    test(
        'a card exactly at the ceiling is stored',
        async () => {
            const { contacts, db } = await makeContacts();
            const id = await contacts.addContact(contactOfExactly(CARD_MAX_BYTES, randomUUID()));

            const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
            expect(row.vcard.byteLength).toBe(CARD_MAX_BYTES);
        },
        CEILING_TIMEOUT_MS,
    );

    test(
        'one byte over the ceiling is refused with 413, and stores nothing',
        async () => {
            const { contacts, db } = await makeContacts();
            const exact = contactOfExactly(CARD_MAX_BYTES, randomUUID());
            const before = db.select().from(contactsSchema.contacts).all().length;

            // One more ORG character is one more byte on the card.
            await expect(contacts.addContact({ ...exact, company: `${exact.company}c` })).rejects.toThrow(/too large/i);

            expect(db.select().from(contactsSchema.contacts).all().length).toBe(before);
        },
        CEILING_TIMEOUT_MS,
    );

    test('an update that would push a card over the ceiling is refused and leaves the stored card intact', async () => {
        const { contacts, db } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Grower' }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

        await expect(
            contacts.updateContact(id, validContact({ firstName: 'Grower', notes: 'n'.repeat(CARD_MAX_BYTES) })),
        ).rejects.toThrow(/too large/i);

        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        expect(after.vcard).toEqual(row.vcard);
        expect(after.etag).toBe(row.etag);
    });
});

describe('Contacts (blob store)', () => {
    test('addContact stores a vcard blob whose parsed projection matches', async () => {
        const { contacts } = await makeContacts();
        const id = await contacts.addContact(
            validContact({
                firstName: 'Grace',
                lastName: 'Hopper',
                email: ['grace@navy.mil'],
                phone: ['+1'],
                company: 'Navy',
                jobTitle: 'Admiral',
            }),
        );

        const parsed = parseVCard(await cardTextOf(contacts, `${id}.vcf`));
        expect(parsed.firstName).toBe('Grace');
        expect(parsed.lastName).toBe('Hopper');
        expect(parsed.email).toEqual(['grace@navy.mil']);
        expect(parsed.company).toBe('Navy');
        expect(parsed.jobTitle).toBe('Admiral');
        expect(parsed.uid).toBe(id);
    });

    test('addContact drops the form-seeded blank email/phone/address so no bare line reaches the blob', async () => {
        const { contacts } = await makeContacts();
        // emptyContact shape: one blank email, one blank phone, one all-empty address.
        const id = await contacts.addContact({
            firstName: 'Blank',
            lastName: 'Fields',
            email: [''],
            phone: [''],
            address: [{}],
            birthday: '',
            notes: '',
            avatar: '',
            labels: [],
        });

        const card = await cardTextOf(contacts, `${id}.vcf`);
        expect(card).not.toMatch(/^EMAIL:/m);
        expect(card).not.toMatch(/^TEL:/m);
        expect(card).not.toMatch(/^ADR/m);
    });

    test('updateContact with a stale etag throws 412', async () => {
        const { contacts, db } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Stale', email: ['stale@example.com'] }));
        const staleEtag = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.id, id))
            .get()!.etag;

        // First write with the fresh etag succeeds and rotates the etag.
        await contacts.updateContact(id, validContact({ firstName: 'Fresh', email: ['stale@example.com'] }), staleEtag);

        // Re-using the now-stale etag is rejected.
        await expect(
            contacts.updateContact(id, validContact({ firstName: 'Loser', email: ['stale@example.com'] }), staleEtag),
        ).rejects.toThrow('Contact was changed elsewhere');
    });

    test('deleteContact writes a tombstone row and bumps book.ctag', async () => {
        const { contacts, db } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Doomed' }));
        const uri = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.uri;
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        await contacts.deleteContact(id);

        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get(),
        ).toBeUndefined();
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, uri))
                .get(),
        ).toBeTruthy();
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBeGreaterThan(ctagBefore);
    });

    test('a second init() seeds nothing new', async () => {
        const { contacts, db } = await makeContacts();
        const contactsBefore = db.select().from(contactsSchema.contacts).all().length;
        const labelsBefore = db.select().from(contactsSchema.labels).all().length;

        await contacts.init();

        expect(db.select().from(contactsSchema.contacts).all().length).toBe(contactsBefore);
        expect(db.select().from(contactsSchema.labels).all().length).toBe(labelsBefore);
    });

    test('getContacts excludes an isGroup row planted directly', async () => {
        const { contacts, db } = await makeContacts();
        const id = randomUUID();
        const uri = `${id}.vcf`;
        db.insert(contactsSchema.contacts)
            .values({
                id,
                uri,
                uid: id,
                vcard: Buffer.from(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nFN:Design Team\r\nEND:VCARD\r\n`),
                firstName: 'Team',
                lastName: 'Group',
                eigenId: '',
                isGroup: true,
                data: { email: [], phone: [] },
                etag: 'planted',
                cardCtag: 0,
            })
            .run();

        const list = await contacts.getContacts();
        expect(list.some((c) => c.id === id)).toBe(false);
        expect(await contacts.getContactById(id)).toBeNull();
    });

    test('the contacts list JSON never leaks an inline photo base64', async () => {
        const { contacts, db, user } = await makeContacts();
        const id = randomUUID();
        const uri = `${id}.vcf`;
        const photoBase64 = Buffer.from('pretend-jpeg-bytes-long-enough-to-detect-0123456789abcdef').toString('base64');

        // A blob with an inline PHOTO beside a row carrying only the projection: the list reads the row and
        // must never surface the base64 the blob holds.
        db.insert(contactsSchema.contacts)
            .values({
                id,
                uri,
                uid: id,
                vcard: Buffer.from(
                    `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nN:Pic;Has;;;\r\nFN:Has Pic\r\nPHOTO;ENCODING=b;TYPE=JPEG:${photoBase64}\r\nEND:VCARD\r\n`,
                ),
                firstName: 'Has',
                lastName: 'Pic',
                eigenId: '',
                isGroup: false,
                data: { email: [], phone: [], avatar: `contacts/${user.id}/avatar/x.webp` },
                etag: 'planted',
                cardCtag: 0,
            })
            .run();

        const list = await contacts.getContacts();
        expect(list.some((c) => c.id === id)).toBe(true);
        expect(JSON.stringify(list)).not.toContain(photoBase64.slice(0, 40));
    });
});

describe('Contacts label membership (CATEGORIES)', () => {
    test('renaming a label rewrites every member card in one transaction and keeps membership', async () => {
        const { contacts, broadcasts, db } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Rename Me', color: '#abcdef' });
        const first = await contacts.addContact(validContact({ firstName: 'Member', labels: [labelId] }));
        const second = await contacts.addContact(
            validContact({ firstName: 'Other', email: ['other@example.com'], labels: [labelId] }),
        );
        const rowOf = (id: string) =>
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const before = [rowOf(first), rowOf(second)];
        expect(await cardTextOf(contacts, before[0].uri)).toContain('CATEGORIES:Rename Me');
        broadcasts.length = 0;

        await contacts.updateLabel(labelId, { name: 'Renamed', color: '#abcdef' });

        for (const row of before) {
            const card = await cardTextOf(contacts, row.uri);
            expect(card).toContain('CATEGORIES:Renamed');
            expect(card).not.toContain('Rename Me');
            expect(rowOf(row.id).etag).not.toBe(row.etag);
        }

        // One transaction, so both cards carry the same new cardCtag and the book advanced exactly once.
        expect(rowOf(first).cardCtag).toBe(rowOf(second).cardCtag);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(before[1].cardCtag + 1);

        // CATEGORIES stays membership truth: the renamed category re-resolves to the same label.
        const links = db
            .select({ labelId: contactsSchema.contactsToLabels.labelId })
            .from(contactsSchema.contactsToLabels)
            .where(eq(contactsSchema.contactsToLabels.contactId, first))
            .all();
        expect(links.map((l) => l.labelId)).toEqual([labelId]);
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(true);
    });

    test('a failed rename leaves the label row and every member card exactly as they were', async () => {
        const { contacts, db } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Before', color: '#111111' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Member', labels: [labelId] }));
        const rowBefore = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.id, contactId))
            .get()!;
        const labelBefore = db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()!;
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        const bytesBefore = await contacts.size();

        // A second label already holding the new name: the rename's UPDATE trips labels.nameKey, and the
        // transaction rolls the member rewrite back with it.
        await contacts.addLabel({ name: 'Taken', color: '#222222' });
        await expect(contacts.updateLabel(labelId, { name: 'Taken', color: '#111111' })).rejects.toThrow(
            'A label with this name already exists',
        );

        expect(db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()).toEqual(
            labelBefore,
        );
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get(),
        ).toEqual(rowBefore);
        expect(await cardTextOf(contacts, rowBefore.uri)).toContain('CATEGORIES:Before');
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
        expect(await contacts.size()).toBe(bytesBefore);
    });

    test('a rename matches a case-variant CATEGORIES value in a member card', async () => {
        const { contacts, db } = await makeContacts();
        const work = db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.nameKey, 'work')).get()!;

        // Plant a card whose CATEGORIES case differs from the label's stored name, with its row and membership
        // link — as an external CardDAV client that lowercases categories might have written it.
        const id = randomUUID();
        const uri = `${id}.vcf`;
        const bytes = new TextEncoder().encode(
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nCATEGORIES:work\r\nEND:VCARD\r\n`,
        );
        db.insert(contactsSchema.contacts)
            .values({
                id,
                uri,
                uid: id,
                vcard: Buffer.from(bytes),
                firstName: 'Jane',
                lastName: 'Doe',
                eigenId: '',
                isGroup: false,
                data: { email: [], phone: [] },
                etag: computeResourceEtag(bytes),
                cardCtag: 0,
            })
            .run();
        db.insert(contactsSchema.contactsToLabels).values({ contactId: id, labelId: work.id }).run();

        await contacts.updateLabel(work.id, { name: 'Boss', color: work.color });

        expect(await cardTextOf(contacts, uri)).toContain('CATEGORIES:Boss');
    });

    test('updating a label that does not exist is refused before anything is emitted', async () => {
        const { contacts, broadcasts } = await makeContacts();
        broadcasts.length = 0;

        await expect(contacts.updateLabel(randomUUID(), { name: 'Ghost', color: '#000000' })).rejects.toThrow(
            'Label not found',
        );

        expect(broadcasts).toEqual([]);
    });

    test('a color-only label update leaves member cards untouched', async () => {
        const { contacts, broadcasts, db } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Keepers', color: '#111111' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Kept', labels: [labelId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        const cardBefore = await cardTextOf(contacts, row.uri);
        broadcasts.length = 0;

        const updated = await contacts.updateLabel(labelId, { name: 'Keepers', color: '#222222' });

        // The wire contract is the Label DTO — no nameKey, no timestamps.
        expect(updated).toEqual({ id: labelId, name: 'Keepers', color: '#222222' });
        expect(await cardTextOf(contacts, row.uri)).toBe(cardBefore);
        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(after.etag).toBe(row.etag);
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(false);
    });

    test('deleting a label removes it from member cards and keeps co-labels', async () => {
        const { contacts, broadcasts, db } = await makeContacts();
        const familyId = db
            .select()
            .from(contactsSchema.labels)
            .where(eq(contactsSchema.labels.nameKey, 'family'))
            .get()!.id;
        const dropId = await contacts.addLabel({ name: 'Drop Me', color: '#333333' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Dual', labels: [familyId, dropId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(await cardTextOf(contacts, row.uri)).toContain('Drop Me');
        broadcasts.length = 0;

        await contacts.deleteLabel(dropId);

        const card = await cardTextOf(contacts, row.uri);
        expect(card).not.toContain('Drop Me');
        expect(card).toContain('Family');
        expect(
            db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, dropId)).get(),
        ).toBeUndefined();

        const links = db
            .select({ labelId: contactsSchema.contactsToLabels.labelId })
            .from(contactsSchema.contactsToLabels)
            .where(eq(contactsSchema.contactsToLabels.contactId, contactId))
            .all();
        expect(links.map((l) => l.labelId)).toEqual([familyId]);
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(true);
    });
});
