import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, fstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { CARD_MAX_BYTES, cardPath, labelColorFor, normalizeLabelName } from '../../lib/contacts/card-store';
import * as contactsSchema from '../../lib/contacts/schema';
import { computeResourceEtag, LocalFilesystem, PATHS, uriKeyOf } from '../../lib/core';
import { createVCard, mergeVCard, parseVCard } from '../../lib/vcard';
import { CONTACTS_TEST_ROOT, cardsDirOf, makeContacts, validContact } from '../contacts-test-helpers';

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
        // Decomposed "café" (e + combining acute) and composed é normalize to the same key.
        expect(normalizeLabelName('Café')).toBe(normalizeLabelName('Café'));
        expect(normalizeLabelName('Café')).toBe('café');
    });
});

describe('labelColorFor', () => {
    test('is deterministic and lands in the accent palette', () => {
        const color = labelColorFor(normalizeLabelName('Work'));
        expect(color).toBe(labelColorFor(normalizeLabelName('Work')));
        expect(EIGEN_ACCENT_COLORS.some((c) => c.value === color)).toBe(true);
    });
});

describe('card file helpers', () => {
    test('cardPath joins under the cards directory', () => {
        expect(cardPath('a.vcf')).toBe(`${PATHS.CONTACTS.CARDS}/a.vcf`);
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
        'a card exactly at the ceiling is written',
        async () => {
            const { contacts, db, dir } = await makeContacts();
            const id = await contacts.addContact(contactOfExactly(CARD_MAX_BYTES, randomUUID()));

            expect(statSync(join(cardsDirOf(dir), `${id}.vcf`)).size).toBe(CARD_MAX_BYTES);
            expect(
                db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.size,
            ).toBe(CARD_MAX_BYTES);
        },
        CEILING_TIMEOUT_MS,
    );

    test(
        'one byte over the ceiling is refused with 413, before anything is written',
        async () => {
            const { contacts, db, dir } = await makeContacts();
            const exact = contactOfExactly(CARD_MAX_BYTES, randomUUID());
            const before = readdirSync(cardsDirOf(dir)).length;

            // One more ORG character is one more byte on the card.
            await expect(contacts.addContact({ ...exact, company: `${exact.company}c` })).rejects.toThrow(/too large/i);

            // Refused before the write intent is recorded: no card file, and no pending row for a drain to chase.
            expect(readdirSync(cardsDirOf(dir)).length).toBe(before);
            expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
        },
        CEILING_TIMEOUT_MS,
    );

    test('an update that would push a card over the ceiling is refused and leaves the stored card intact', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Grower' }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const cardBefore = readFileSync(join(cardsDirOf(dir), row.uri), 'utf8');

        await expect(
            contacts.updateContact(id, validContact({ firstName: 'Grower', notes: 'n'.repeat(CARD_MAX_BYTES) })),
        ).rejects.toThrow(/too large/i);

        expect(readFileSync(join(cardsDirOf(dir), row.uri), 'utf8')).toBe(cardBefore);
        expect(db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.etag).toBe(
            row.etag,
        );
        expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
    });
});

describe('Contacts (file-backed store)', () => {
    test('addContact writes a cards/<id>.vcf whose parsed projection matches', async () => {
        const { contacts, dir } = await makeContacts();
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

        const cardFile = join(cardsDirOf(dir), `${id}.vcf`);
        expect(existsSync(cardFile)).toBe(true);

        const parsed = parseVCard(readFileSync(cardFile, 'utf8'));
        expect(parsed.firstName).toBe('Grace');
        expect(parsed.lastName).toBe('Hopper');
        expect(parsed.email).toEqual(['grace@navy.mil']);
        expect(parsed.company).toBe('Navy');
        expect(parsed.jobTitle).toBe('Admiral');
        expect(parsed.uid).toBe(id);
    });

    test('addContact drops the form-seeded blank email/phone/address so no bare line reaches the file', async () => {
        const { contacts, dir } = await makeContacts();
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

        const card = readFileSync(join(cardsDirOf(dir), `${id}.vcf`), 'utf8');
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
                uriKey: uriKeyOf(uri),
                uid: id,
                firstName: 'Team',
                lastName: 'Group',
                eigenId: '',
                isGroup: true,
                data: { email: [], phone: [] },
                etag: 'planted',
                cardCtag: 0,
                mtime: 0,
                size: 0,
            })
            .run();

        const list = await contacts.getContacts();
        expect(list.some((c) => c.id === id)).toBe(false);
        expect(await contacts.getContactById(id)).toBeNull();
    });

    test('the contacts list JSON never leaks an inline photo base64', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const id = randomUUID();
        const uri = `${id}.vcf`;
        const photoBase64 = Buffer.from('pretend-jpeg-bytes-long-enough-to-detect-0123456789abcdef').toString('base64');

        // A card FILE with an inline PHOTO plus an index row carrying only the projection: reads serve from the
        // index and must never surface the base64 the file holds.
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(
            join(cardsDirOf(dir), uri),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nN:Pic;Has;;;\r\nFN:Has Pic\r\nPHOTO;ENCODING=b;TYPE=JPEG:${photoBase64}\r\nEND:VCARD\r\n`,
        );
        db.insert(contactsSchema.contacts)
            .values({
                id,
                uri,
                uriKey: uriKeyOf(uri),
                uid: id,
                firstName: 'Has',
                lastName: 'Pic',
                eigenId: '',
                isGroup: false,
                data: { email: [], phone: [], avatar: `contacts/${user.id}/avatar/x.webp` },
                etag: 'planted',
                cardCtag: 0,
                mtime: 0,
                size: 0,
            })
            .run();

        const list = await contacts.getContacts();
        expect(list.some((c) => c.id === id)).toBe(true);
        expect(JSON.stringify(list)).not.toContain(photoBase64.slice(0, 40));
    });
});

describe('Contacts label membership (CATEGORIES)', () => {
    const readCard = (dir: string, uri: string) => readFileSync(join(cardsDirOf(dir), uri), 'utf8');

    test('renaming a label rewrites its member cards, rotates their etag, and keeps membership', async () => {
        const { contacts, broadcasts, db, dir } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Rename Me', color: '#abcdef' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Member', labels: [labelId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(readCard(dir, row.uri)).toContain('CATEGORIES:Rename Me');
        const etagBefore = row.etag;
        broadcasts.length = 0;

        await contacts.updateLabel(labelId, { name: 'Renamed', color: '#abcdef' });

        const card = readCard(dir, row.uri);
        expect(card).toContain('CATEGORIES:Renamed');
        expect(card).not.toContain('Rename Me');

        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(after.etag).not.toBe(etagBefore);

        // CATEGORIES stays membership truth: the renamed category re-resolves to the same label.
        const links = db
            .select({ labelId: contactsSchema.contactsToLabels.labelId })
            .from(contactsSchema.contactsToLabels)
            .where(eq(contactsSchema.contactsToLabels.contactId, contactId))
            .all();
        expect(links.map((l) => l.labelId)).toEqual([labelId]);
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(true);
    });

    test('a concurrent old-name add waits for failed rename compensation, rejects, and retry converges', async () => {
        const { contacts, db, dir } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Before', color: '#111111' });
        await contacts.addContact(validContact({ firstName: 'First', labels: [labelId] }));
        await contacts.addContact(validContact({ firstName: 'Second', labels: [labelId] }));
        const memberIds = db
            .select({ contactId: contactsSchema.contactsToLabels.contactId })
            .from(contactsSchema.contactsToLabels)
            .where(eq(contactsSchema.contactsToLabels.labelId, labelId))
            .all()
            .map((link) => link.contactId);
        expect(memberIds).toHaveLength(2);
        const rows = memberIds.map(
            (id) => db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!,
        );

        const photoBytes = Uint8Array.from({ length: 96 }, (_, index) => (index * 13) % 256);
        const photoCard = mergeVCard(parseVCard(readCard(dir, rows[0].uri)), {
            photo: { bytes: photoBytes, mediaType: 'image/jpeg' },
        });
        writeFileSync(join(cardsDirOf(dir), rows[0].uri), photoCard);
        const photoBlock = (raw: string) => raw.match(/PHOTO[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/)?.[0] ?? '';
        const photoBefore = photoBlock(photoCard);
        expect(photoBefore).not.toBe('');

        const oldUpdatedAt = new Date(Date.now() - 60_000);
        db.update(contactsSchema.labels)
            .set({ updatedAt: oldUpdatedAt })
            .where(eq(contactsSchema.labels.id, labelId))
            .run();
        const labelBefore = db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()!;
        const labelCountBefore = db.select().from(contactsSchema.labels).all().length;
        const linksBefore = [...memberIds].sort();

        const storage = (
            contacts as unknown as {
                storage: { stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }> };
            }
        ).storage;
        const originalStat = storage.stat;
        let cardStats = 0;
        let reachFailure!: () => void;
        const failureReached = new Promise<void>((resolve) => {
            reachFailure = resolve;
        });
        let releaseFailure!: () => void;
        const failureReleased = new Promise<void>((resolve) => {
            releaseFailure = resolve;
        });
        storage.stat = async (filePath) => {
            if (filePath.startsWith('cards/') && ++cardStats === 2) {
                reachFailure();
                await failureReleased;
                throw new Error('later card stat boom');
            }
            return originalStat.call(storage, filePath);
        };

        const insertSpy = spyOn(db, 'insert');
        const rename = contacts.updateLabel(labelId, { name: 'After', color: '#222222' });
        await failureReached;
        insertSpy.mockClear();
        const queuedAdd = contacts.addLabel({ name: 'Before', color: '#333333' });
        const addEnteredBeforeRelease = insertSpy.mock.calls.length > 0;
        // On the broken path addLabel is outside the semaphore. Let it claim the old name before the failed
        // rename resumes, deterministically recreating the compensation conflict this regression guards.
        try {
            if (addEnteredBeforeRelease) await queuedAdd;
        } finally {
            releaseFailure();
        }

        try {
            await expect(rename).rejects.toThrow('later card stat boom');
        } finally {
            storage.stat = originalStat;
            insertSpy.mockRestore();
        }

        let queuedError: unknown;
        try {
            await queuedAdd;
        } catch (error) {
            queuedError = error;
        }
        expect(addEnteredBeforeRelease).toBe(false);
        expect(queuedError).toBeInstanceOf(Error);
        if (queuedError instanceof Error) {
            expect(queuedError.message).toBe('A label with this name already exists');
        }
        expect(db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()).toEqual(
            labelBefore,
        );
        for (const row of rows) {
            expect(parseVCard(readCard(dir, row.uri)).categories).toEqual(['Before']);
        }
        expect(photoBlock(readCard(dir, rows[0].uri))).toBe(photoBefore);

        await contacts.updateLabel(labelId, { name: 'After', color: '#222222' });

        const labelAfter = db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()!;
        expect(labelAfter.id).toBe(labelId);
        expect(labelAfter.name).toBe('After');
        expect(labelAfter.nameKey).toBe('after');
        expect(labelAfter.color).toBe('#222222');
        expect(
            db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.nameKey, 'after')).all(),
        ).toHaveLength(1);
        expect(
            db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.nameKey, 'before')).all(),
        ).toEqual([]);
        expect(db.select().from(contactsSchema.labels).all()).toHaveLength(labelCountBefore);
        expect(
            db
                .select({ contactId: contactsSchema.contactsToLabels.contactId })
                .from(contactsSchema.contactsToLabels)
                .where(eq(contactsSchema.contactsToLabels.labelId, labelId))
                .all()
                .map((link) => link.contactId)
                .sort(),
        ).toEqual(linksBefore);
        for (const row of rows) {
            expect(parseVCard(readCard(dir, row.uri)).categories).toEqual(['After']);
        }
        expect(photoBlock(readCard(dir, rows[0].uri))).toBe(photoBefore);
    });

    test('a rename matches a case-variant CATEGORIES value in a member card', async () => {
        const { contacts, db, dir } = await makeContacts();
        const work = db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.nameKey, 'work')).get()!;

        // Plant a card whose CATEGORIES case differs from the label's stored name, with its index row and
        // membership link — as an external CardDAV client that lowercases categories might have written it.
        const id = randomUUID();
        const uri = `${id}.vcf`;
        const bytes = new TextEncoder().encode(
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nCATEGORIES:work\r\nEND:VCARD\r\n`,
        );
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(join(cardsDirOf(dir), uri), bytes);
        db.insert(contactsSchema.contacts)
            .values({
                id,
                uri,
                uriKey: uriKeyOf(uri),
                uid: id,
                firstName: 'Jane',
                lastName: 'Doe',
                eigenId: '',
                isGroup: false,
                data: { email: [], phone: [] },
                etag: computeResourceEtag(bytes),
                cardCtag: 0,
                mtime: 0,
                size: bytes.byteLength,
            })
            .run();
        db.insert(contactsSchema.contactsToLabels).values({ contactId: id, labelId: work.id }).run();

        await contacts.updateLabel(work.id, { name: 'Boss', color: work.color });

        expect(readCard(dir, uri)).toContain('CATEGORIES:Boss');
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
        const { contacts, broadcasts, db, dir } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Keepers', color: '#111111' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Kept', labels: [labelId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        const cardBefore = readCard(dir, row.uri);
        const etagBefore = row.etag;
        broadcasts.length = 0;

        const updated = await contacts.updateLabel(labelId, { name: 'Keepers', color: '#222222' });

        // The wire contract is the Label DTO — no nameKey, no timestamps.
        expect(updated).toEqual({ id: labelId, name: 'Keepers', color: '#222222' });
        expect(readCard(dir, row.uri)).toBe(cardBefore);
        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(after.etag).toBe(etagBefore);
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(false);
    });

    test('deleting a label removes it from member cards and keeps co-labels', async () => {
        const { contacts, broadcasts, db, dir } = await makeContacts();
        const familyId = db
            .select()
            .from(contactsSchema.labels)
            .where(eq(contactsSchema.labels.nameKey, 'family'))
            .get()!.id;
        const dropId = await contacts.addLabel({ name: 'Drop Me', color: '#333333' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Dual', labels: [familyId, dropId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        expect(readCard(dir, row.uri)).toContain('Drop Me');
        broadcasts.length = 0;

        await contacts.deleteLabel(dropId);

        const card = readCard(dir, row.uri);
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
