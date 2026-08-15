import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { mergeVCard } from '../lib/carddav/vcard-serialize';
import {
    CARD_MAX_BYTES,
    CARDS_DIR,
    cardPath,
    cleanupTempCardFiles,
    computeCardEtag,
    labelColorFor,
    normalizeLabelName,
    sanitizeCardUri,
    uriKeyOf,
    writeCardFile,
} from '../lib/contacts/card-store';
import * as contactsSchema from '../lib/contacts/schema';
import { LocalFilesystem } from '../lib/core';
import { CONTACTS_TEST_ROOT, makeContacts, validContact } from './contacts-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-card-store-${Date.now()}`);
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
});

describe('sanitizeCardUri', () => {
    test('accepts well-formed .vcf resource names', () => {
        expect(sanitizeCardUri('ABC-123.vcf')).toBe('ABC-123.vcf');
        expect(sanitizeCardUri('a.b@c.vcf')).toBe('a.b@c.vcf');
    });

    test('rejects traversal, hidden, slash, trailing-space and control chars', () => {
        expect(sanitizeCardUri('../x.vcf')).toBeNull();
        expect(sanitizeCardUri('.hidden.vcf')).toBeNull();
        expect(sanitizeCardUri('a/b.vcf')).toBeNull();
        expect(sanitizeCardUri('x.vcf ')).toBeNull();
        expect(sanitizeCardUri('a\nb.vcf')).toBeNull();
        expect(sanitizeCardUri('x .vcf')).toBeNull();
    });

    test('requires the literal lowercase .vcf suffix', () => {
        expect(sanitizeCardUri('x.VCF')).toBeNull();
        expect(sanitizeCardUri('x.txt')).toBeNull();
    });

    test('rejects empty and over-long names', () => {
        expect(sanitizeCardUri('')).toBeNull();
        expect(sanitizeCardUri(`${'a'.repeat(256)}.vcf`)).toBeNull();
        // The cap is 200 (spec § 4) so writeAtomic's `.`-prefixed temp name stays under NAME_MAX. The bound
        // lives in the length check alone (the regex owns only the charset): 200 chars pass, 201 fail.
        expect(sanitizeCardUri(`${'a'.repeat(210)}.vcf`)).toBeNull();
        expect(sanitizeCardUri(`${'a'.repeat(196)}.vcf`)).toBe(`${'a'.repeat(196)}.vcf`);
        expect(sanitizeCardUri(`${'a'.repeat(197)}.vcf`)).toBeNull();
    });
});

describe('uriKeyOf', () => {
    test('lowercases the uri', () => {
        expect(uriKeyOf('AbC.vcf')).toBe('abc.vcf');
    });

    test('NFC-normalizes before lowercasing', () => {
        // Decomposed A + combining ring above and composed Å collapse to one key.
        expect(uriKeyOf('Å.vcf')).toBe(uriKeyOf('Å.vcf'));
    });
});

describe('computeCardEtag', () => {
    test('is the sha256 hex of the bytes', () => {
        expect(computeCardEtag(new TextEncoder().encode('x'))).toBe(
            '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
        );
    });
});

describe('CARD_MAX_BYTES', () => {
    test('caps the whole vCard resource at 256 KiB', () => {
        expect(CARD_MAX_BYTES).toBe(262_144);
    });
});

describe('normalizeLabelName', () => {
    test('trims, lowercases and NFC-normalizes', () => {
        expect(normalizeLabelName('  Work  ')).toBe('work');
        // Decomposed "café" (e + combining acute) and composed é normalize to the same key.
        expect(normalizeLabelName('Café')).toBe(normalizeLabelName('Café'));
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
        expect(cardPath('a.vcf')).toBe(`${CARDS_DIR}/a.vcf`);
    });

    test('writeCardFile persists the bytes and reports size', async () => {
        const { store } = nextStore();
        const bytes = new TextEncoder().encode('BEGIN:VCARD\r\nUID:1\r\nEND:VCARD\r\n');
        const { mtime, size } = await writeCardFile(store, 'card.vcf', bytes);

        expect(size).toBe(bytes.byteLength);
        expect(mtime).toBeGreaterThan(0);
        expect(new Uint8Array(await store.file('cards/card.vcf').arrayBuffer())).toEqual(bytes);
    });

    test('cleanupTempCardFiles removes only the dot-prefixed .tmp- leftovers', async () => {
        const { store, base } = nextStore();
        await store.mkdir('cards');
        const cardsDir = join(base, 'cards');
        writeFileSync(join(cardsDir, 'real.vcf'), 'x');
        writeFileSync(join(cardsDir, '.real.vcf.tmp-abc'), 'x');
        // A stray non-`.vcf` (README, csv, a mixed-case .VCF) is NOT temp debris — it survives the sweep and is
        // warn-skipped by reconcile/rebuild instead of being silently deleted. A hand-placed dotfile without
        // the `.tmp-` infix (a `.backup.vcf`) is not writeAtomic debris either and must survive.
        writeFileSync(join(cardsDir, 'stray.txt'), 'x');
        writeFileSync(join(cardsDir, 'x.VCF'), 'x');
        writeFileSync(join(cardsDir, '.backup.vcf'), 'x');

        await cleanupTempCardFiles(store);

        expect(readdirSync(cardsDir).sort()).toEqual(['.backup.vcf', 'real.vcf', 'stray.txt', 'x.VCF']);
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

        const cardFile = join(dir, 'eigen.contacts', 'cards', `${id}.vcf`);
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

        const card = readFileSync(join(dir, 'eigen.contacts', 'cards', `${id}.vcf`), 'utf8');
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
        mkdirSync(join(dir, 'eigen.contacts', 'cards'), { recursive: true });
        writeFileSync(
            join(dir, 'eigen.contacts', 'cards', uri),
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
    const readCard = (dir: string, uri: string) => readFileSync(join(dir, 'eigen.contacts', 'cards', uri), 'utf8');

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
        writeFileSync(join(dir, 'eigen.contacts', 'cards', rows[0].uri), photoCard);
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
        mkdirSync(join(dir, 'eigen.contacts', 'cards'), { recursive: true });
        writeFileSync(join(dir, 'eigen.contacts', 'cards', uri), bytes);
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
                etag: computeCardEtag(bytes),
                cardCtag: 0,
                mtime: 0,
                size: bytes.byteLength,
            })
            .run();
        db.insert(contactsSchema.contactsToLabels).values({ contactId: id, labelId: work.id }).run();

        await contacts.updateLabel(work.id, { name: 'Boss', color: work.color });

        expect(readCard(dir, uri)).toContain('CATEGORIES:Boss');
    });

    test('a color-only label update leaves member cards untouched', async () => {
        const { contacts, broadcasts, db, dir } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Keepers', color: '#111111' });
        const contactId = await contacts.addContact(validContact({ firstName: 'Kept', labels: [labelId] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, contactId)).get()!;
        const cardBefore = readCard(dir, row.uri);
        const etagBefore = row.etag;
        broadcasts.length = 0;

        await contacts.updateLabel(labelId, { name: 'Keepers', color: '#222222' });

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
