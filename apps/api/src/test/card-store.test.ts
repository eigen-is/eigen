import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import type { Contact } from '@workspace/lib/types/contact';
import type { SSEvent } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { parseVCard } from '../lib/carddav/vcard-parse';
import {
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
import { Contacts } from '../lib/contacts/contacts';
import * as contactsSchema from '../lib/contacts/schema';
import { type DatabaseConfig, LocalFilesystem, ManagedDatabase, type SchemaType } from '../lib/core';
import type { Home } from '../lib/home';

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

    test('cleanupTempCardFiles removes temp/non-vcf leftovers but keeps real cards', async () => {
        const { store, base } = nextStore();
        await store.mkdir('cards');
        const cardsDir = join(base, 'cards');
        writeFileSync(join(cardsDir, 'real.vcf'), 'x');
        writeFileSync(join(cardsDir, '.real.vcf.tmp-abc'), 'x');
        writeFileSync(join(cardsDir, 'stray.txt'), 'x');

        await cleanupTempCardFiles(store);

        expect(readdirSync(cardsDir)).toEqual(['real.vcf']);
    });
});

// Isolated Contacts instance over a temp home dir (mount.test.ts's pattern): a stub Home supplies only the
// members Contacts touches — a memoized getLocalDatabase (so a second init() reuses the same connection),
// the current user, and a broadcast sink.
async function makeContacts() {
    const dir = join(TEST_DIR, `home-${counter++}`);
    const broadcasts: SSEvent[] = [];
    const user = { id: randomUUID(), email: `me-${counter}@test.local`, name: 'Ada Lovelace' };
    const dbCache = new Map<string, Promise<ManagedDatabase<SchemaType>>>();
    const getLocalDatabase = ((config: DatabaseConfig<SchemaType>, relativePath: string) => {
        let entry = dbCache.get(relativePath);
        if (!entry) {
            entry = (async () => {
                const mdb = new ManagedDatabase(config, join(dir, relativePath));
                await mdb.open(0);
                return mdb;
            })();
            dbCache.set(relativePath, entry);
        }
        return entry;
    }) as Home['getLocalDatabase'];
    const home = {
        homeDir: dir,
        user,
        getLocalDatabase,
        broadcast: (e: SSEvent) => broadcasts.push(e),
    } as unknown as Home;
    const contacts = new Contacts(home);
    await contacts.init();
    const managed = (await dbCache.get('eigen.contacts/contacts.db')!) as ManagedDatabase<typeof contactsSchema>;
    return { contacts, broadcasts, user, dir, db: managed.db };
}

const validContact = (over: Partial<Omit<Contact, 'id'>>): Omit<Contact, 'id'> => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['ada@example.com'],
    phone: [],
    ...over,
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
