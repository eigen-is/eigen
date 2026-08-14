import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '@workspace/lib/types/contact';
import { type SSEvent, SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { mergeVCard } from '../lib/carddav/vcard-serialize';
import { labelColorFor, normalizeLabelName, uriKeyOf } from '../lib/contacts/card-store';
import { Contacts } from '../lib/contacts/contacts';
import * as contactsSchema from '../lib/contacts/schema';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import type { Home } from '../lib/home';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-contacts-reconcile-${Date.now()}`);
let counter = 0;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

// Isolated Contacts instance over a temp home dir (card-store.test.ts's pattern): a stub Home supplies only
// the members Contacts touches — a memoized getLocalDatabase (so a second init() reuses the same connection),
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

const cardsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'cards');
const cardPathOf = (dir: string, uri: string) => join(cardsDirOf(dir), uri);
const avatarsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'avatars');
const parseCount = (contacts: Contacts) => contacts.cardParseCount;
const uriOf = (db: Awaited<ReturnType<typeof makeContacts>>['db'], id: string) =>
    db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.uri;

async function stageAvatar(contacts: Contacts): Promise<string> {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 120, b: 200 } } })
        .png()
        .toBuffer();
    return contacts.uploadAvatar(new File([new Uint8Array(png)], 'avatar.png', { type: 'image/png' }));
}

describe('reconcileIndex (stat-only pass)', () => {
    test('a clean second init re-parses zero files and leaves the ctag untouched', async () => {
        const { contacts, db } = await makeContacts();
        const parsesBefore = parseCount(contacts);
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        await contacts.init();

        expect(parseCount(contacts)).toBe(parsesBefore);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
    });

    test('a hand-written card is indexed, its label auto-created, with one ctag bump', async () => {
        const { contacts, broadcasts, db, dir } = await makeContacts();
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        const id = randomUUID();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(
            cardPathOf(dir, 'manual.vcf'),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${id}\r\nN:Babbage;Charles;;;\r\nFN:Charles Babbage\r\nEMAIL:charles@example.com\r\nCATEGORIES:Inventors\r\nEND:VCARD\r\n`,
        );
        broadcasts.length = 0;

        await contacts.init();

        const list = await contacts.getContacts();
        const row = list.find((c) => c.firstName === 'Charles');
        expect(row).toBeTruthy();
        expect(row?.labels?.length).toBe(1);

        // The novel CATEGORIES minted a label with its deterministic color, broadcast as LABEL_CREATED.
        const labels = await contacts.getLabels();
        const inventors = labels.find((l) => l.name === 'Inventors')!;
        expect(inventors.color).toBe(labelColorFor(normalizeLabelName('Inventors')));
        expect(broadcasts.some((e) => e.type === SSEventType.LABEL_CREATED)).toBe(true);

        // Exactly one bump for the whole pass.
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore + 1);
    });

    test('a card file removed on disk is tombstoned and drops out of the list', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Doomed', email: ['doomed@example.com'] }));
        const uri = uriOf(db, id);

        rmSync(cardPathOf(dir, uri));
        await contacts.init();

        expect((await contacts.getContacts()).some((c) => c.id === id)).toBe(false);
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, uri))
                .get(),
        ).toBeTruthy();
    });

    test('an out-of-band file edit refreshes the row etag/notes and bumps cardCtag', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Edit', email: ['edit@example.com'] }));
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

        const card = parseVCard(readFileSync(cardPathOf(dir, before.uri), 'utf8'));
        writeFileSync(cardPathOf(dir, before.uri), mergeVCard(card, { notes: 'edited out of band' }));
        await contacts.init();

        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        expect(after.etag).not.toBe(before.etag);
        expect(after.cardCtag).toBeGreaterThan(before.cardCtag);
        expect((await contacts.getContactById(id))?.notes).toBe('edited out of band');
    });

    test('a drifted card with an inline photo regenerates a missing avatar cache', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Pic', avatar: staged }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const cacheName = (row.data?.avatar ?? '').split('/').pop()!;
        expect(cacheName.endsWith('.webp')).toBe(true);

        // Drop the derived cache and force a drift so reconcile re-reads the card.
        rmSync(join(avatarsDirOf(dir), cacheName));
        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(false);
        const future = new Date(Date.now() + 5000);
        utimesSync(cardPathOf(dir, row.uri), future, future);

        await contacts.init();

        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(true);
        expect((await contacts.getContactById(id))?.avatar).toBe(`contacts/${user.id}/avatar/${cacheName}`);
    });
});

describe('eigenId rematch', () => {
    test('an owner-email card with a stripped X-EIGEN-ID reclaims the self-link and rewrites the file', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const uri = uriOf(db, me.id);

        // A client stripped X-EIGEN-ID but kept the owner's email — the § 2 rematch scenario.
        const stripped = mergeVCard(parseVCard(readFileSync(cardPathOf(dir, uri), 'utf8')), { eigenId: null });
        expect(stripped).not.toContain('X-EIGEN-ID');
        writeFileSync(cardPathOf(dir, uri), stripped);

        await contacts.init();

        expect(readFileSync(cardPathOf(dir, uri), 'utf8')).toContain(`X-EIGEN-ID:${user.id}`);
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, me.id)).get()!;
        expect(row.eigenId).toBe(user.id);

        // getMe stays pinned to the same card — no duplicate skeleton minted.
        const after = await contacts.getMe();
        expect(after?.id).toBe(me.id);
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.eigenId, user.id)).all().length,
        ).toBe(1);
    });

    test('a second self-claiming card indexes as a plain contact and getMe stays pinned', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const forgedId = randomUUID();
        writeFileSync(
            cardPathOf(dir, 'forged.vcf'),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${forgedId}\r\nN:Impostor;An;;;\r\nFN:An Impostor\r\nEMAIL:impostor@example.com\r\nX-EIGEN-ID:${user.id}\r\nEND:VCARD\r\n`,
        );

        await contacts.init();

        const forged = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('forged.vcf')))
            .get()!;
        expect(forged.eigenId).toBe('');
        expect((await contacts.getMe())?.id).toBe(me.id);
    });
});

// The self-link is a single ranked slot: incumbent (existing indexed link) beats a strong X-EIGEN-ID claim,
// which beats a weak owner-email match. Iteration is uri-sorted, so these plant a claimant that sorts BEFORE
// the self card to prove rank — not lexical order — decides the winner.
describe('self-link ranking', () => {
    // `0.vcf` / `00.vcf` are lexically < any `<uuid>.vcf`, so the claimant is always visited first.
    const emailTwin = (email: string) =>
        `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${randomUUID()}\r\nN:Twin;Email;;;\r\nFN:Email Twin\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
    const forgedCard = (userId: string) =>
        `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${randomUUID()}\r\nN:Impostor;An;;;\r\nFN:An Impostor\r\nEMAIL:impostor@example.com\r\nX-EIGEN-ID:${userId}\r\nEND:VCARD\r\n`;
    const selfLinkRows = (db: Awaited<ReturnType<typeof makeContacts>>['db'], userId: string) =>
        db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, userId))
            .all()
            .map((r) => r.id);

    test('a drifting self card outranks an earlier owner-email twin (reconcile)', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const selfUri = uriOf(db, me.id);

        writeFileSync(cardPathOf(dir, '0.vcf'), emailTwin(user.email));
        expect('0.vcf' < selfUri).toBe(true);
        const future = new Date(Date.now() + 5000);
        utimesSync(cardPathOf(dir, selfUri), future, future); // drift the self card, content intact

        await contacts.init();

        expect((await contacts.getMe())?.id).toBe(me.id);
        expect(selfLinkRows(db, user.id)).toEqual([me.id]);
        const twin = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('0.vcf')))
            .get()!;
        expect(twin.eigenId).toBe('');
        // The loser's file is never given X-EIGEN-ID.
        expect(readFileSync(cardPathOf(dir, '0.vcf'), 'utf8')).not.toContain('X-EIGEN-ID');
    });

    test('rebuild keeps the self-link on the incumbent over an earlier owner-email twin', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        writeFileSync(cardPathOf(dir, '0.vcf'), emailTwin(user.email));
        await contacts.init(); // index the twin (loses to the clean incumbent self row)
        const syncGenBefore = db.select().from(contactsSchema.book).get()!.syncGen;

        await contacts.rebuildIndex();

        expect((await contacts.getMe())?.id).toBe(me.id);
        expect(selfLinkRows(db, user.id)).toEqual([me.id]);
        const twin = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('0.vcf')))
            .get()!;
        expect(twin.eigenId).toBe('');
        expect(readFileSync(cardPathOf(dir, '0.vcf'), 'utf8')).not.toContain('X-EIGEN-ID');
        expect(db.select().from(contactsSchema.book).get()!.syncGen).toBe(syncGenBefore + 1);
    });

    test('a drifting self card outranks an earlier forged X-EIGEN-ID card, whose file keeps it verbatim', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const selfUri = uriOf(db, me.id);

        writeFileSync(cardPathOf(dir, '00.vcf'), forgedCard(user.id));
        expect('00.vcf' < selfUri).toBe(true);
        const future = new Date(Date.now() + 5000);
        utimesSync(cardPathOf(dir, selfUri), future, future);

        await contacts.init();

        expect((await contacts.getMe())?.id).toBe(me.id);
        expect(selfLinkRows(db, user.id)).toEqual([me.id]);
        const forged = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('00.vcf')))
            .get()!;
        expect(forged.eigenId).toBe('');
        // We never strip an unowned claim — the forged property rides through the file verbatim, just unindexed.
        expect(readFileSync(cardPathOf(dir, '00.vcf'), 'utf8')).toContain(`X-EIGEN-ID:${user.id}`);
    });
});

describe('rebuildIndex', () => {
    test('rebuilding a populated book reproduces projections + etags, rotates syncGen, clears tombstones', async () => {
        const { contacts, db } = await makeContacts();
        await contacts.addContact(validContact({ firstName: 'Keep', lastName: 'One', email: ['keep1@example.com'] }));
        await contacts.addContact(validContact({ firstName: 'Keep', lastName: 'Two', email: ['keep2@example.com'] }));
        const goneId = await contacts.addContact(validContact({ firstName: 'Gone', email: ['gone@example.com'] }));
        await contacts.deleteContact(goneId);
        expect(db.select().from(contactsSchema.contactTombstones).all().length).toBe(1);

        // Compare faithfully, not byte-for-byte: an unset optional field is a dropped key from addContact's
        // toData but an '' / [] from the file-parse projection — both are empty. Drop empty optionals on both
        // sides so a real value difference (not a representation one) is what would fail.
        const projection = (list: Contact[]) =>
            JSON.stringify(
                list
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .map((c) => {
                        const out: Record<string, unknown> = {};
                        for (const [k, v] of Object.entries(c)) {
                            if (v === '' || (Array.isArray(v) && v.length === 0)) continue;
                            out[k] = v;
                        }
                        return out;
                    }),
            );
        const projectionsBefore = projection(await contacts.getContacts());
        const etagsBefore = new Map(
            db
                .select()
                .from(contactsSchema.contacts)
                .all()
                .map((r) => [r.id, r.etag] as const),
        );
        expect(db.select().from(contactsSchema.book).get()!.syncGen).toBe(1);

        await contacts.rebuildIndex();

        expect(projection(await contacts.getContacts())).toBe(projectionsBefore);
        for (const r of db.select().from(contactsSchema.contacts).all()) {
            expect(r.etag).toBe(etagsBefore.get(r.id)!);
        }
        expect(db.select().from(contactsSchema.book).get()!.syncGen).toBe(2);
        expect(db.select().from(contactsSchema.contactTombstones).all().length).toBe(0);
    });

    test('init rebuilds when the book row is missing, rotating syncGen', async () => {
        const { contacts, db } = await makeContacts();
        const me = (await contacts.getMe())!;
        db.delete(contactsSchema.book).run();

        await contacts.init();

        expect(db.select().from(contactsSchema.book).get()!.syncGen).toBe(2);
        expect((await contacts.getContactById(me.id))?.eigenId).toBe(me.eigenId);
    });

    test('a same-length, timestamp-preserved replacement is missed by reconcile but caught by rebuild', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Same', email: ['same@example.com'], notes: 'ZZZZ' }),
        );
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const syncGenBefore = db.select().from(contactsSchema.book).get()!.syncGen;

        // Overwrite with different, same-length bytes and pin the mtime back to the indexed value.
        const raw = readFileSync(cardPathOf(dir, before.uri), 'utf8');
        expect(raw).toContain('ZZZZ');
        writeFileSync(cardPathOf(dir, before.uri), raw.replace('ZZZZ', 'QQQQ'));
        utimesSync(cardPathOf(dir, before.uri), new Date(), new Date(before.mtime));

        await contacts.init(); // stat-only reconcile cannot see it
        expect(db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.etag).toBe(
            before.etag,
        );

        await contacts.rebuildIndex(); // full re-read does
        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        expect(after.etag).not.toBe(before.etag);
        expect(db.select().from(contactsSchema.book).get()!.syncGen).toBe(syncGenBefore + 1);
    });
});

describe('fail-closed drain guard', () => {
    test('a clean read takes no lock (drainDirty short-circuits) but a pending failure drains first', async () => {
        const { contacts } = await makeContacts();

        let drainCalls = 0;
        const proto = Object.getPrototypeOf(contacts) as { drainDirty: () => Promise<void> };
        const origDrain = proto.drainDirty;
        (contacts as unknown as { drainDirty: () => Promise<void> }).drainDirty = function (this: Contacts) {
            drainCalls++;
            return origDrain.apply(this);
        };

        // Clean book: the guard short-circuits on the empty set — no drain, no lock, no file touch.
        await contacts.getContacts();
        expect(drainCalls).toBe(0);

        // A commit that throws after the file wrote leaves an orphaned card marked dirty.
        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        const origCommit = priv.commitCard;
        let thrown = false;
        priv.commitCard = function (this: Contacts, o: unknown) {
            if (!thrown) {
                thrown = true;
                throw new Error('commit boom');
            }
            return origCommit.call(this, o);
        };
        await expect(
            contacts.addContact(validContact({ firstName: 'Orphan', email: ['orphan@example.com'] })),
        ).rejects.toThrow('commit boom');
        priv.commitCard = origCommit;

        // The next read of any kind drains the dirty set first, so the orphaned card gets indexed and served.
        drainCalls = 0;
        const list = await contacts.getContacts();
        expect(drainCalls).toBe(1);
        expect(list.some((c) => c.firstName === 'Orphan')).toBe(true);
    });

    test('deleteContact fails closed: a commit throw after the file delete tombstones on the next read', async () => {
        const { contacts, db } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Vanish', email: ['vanish@example.com'] }));
        const uri = uriOf(db, id);

        const priv = contacts as unknown as { bumpCtag: (tx: unknown) => number };
        const origBump = priv.bumpCtag;
        let boom = false;
        priv.bumpCtag = function (this: Contacts, tx: unknown) {
            if (!boom) {
                boom = true;
                throw new Error('bump boom');
            }
            return origBump.call(this, tx);
        };
        await expect(contacts.deleteContact(id)).rejects.toThrow('bump boom');
        priv.bumpCtag = origBump;

        // The file is already gone; the next read drains and tombstones the vanished card.
        expect((await contacts.getContacts()).some((c) => c.id === id)).toBe(false);
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, uri))
                .get(),
        ).toBeTruthy();
    });

    test('size() drains a pending failure so the total reflects the healed card', async () => {
        const { contacts } = await makeContacts();
        const sizeBefore = await contacts.size(); // clean baseline, before any orphan exists

        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        const origCommit = priv.commitCard;
        let thrown = false;
        priv.commitCard = function (this: Contacts, o: unknown) {
            if (!thrown) {
                thrown = true;
                throw new Error('commit boom');
            }
            return origCommit.call(this, o);
        };
        await expect(
            contacts.addContact(validContact({ firstName: 'Sized', email: ['sized@example.com'] })),
        ).rejects.toThrow('commit boom');
        priv.commitCard = origCommit;

        // Spy AFTER the failure so the very next read is the one that must drain (size() has not run since).
        let drainCalls = 0;
        const proto = Object.getPrototypeOf(contacts) as { drainDirty: () => Promise<void> };
        const origDrain = proto.drainDirty;
        (contacts as unknown as { drainDirty: () => Promise<void> }).drainDirty = function (this: Contacts) {
            drainCalls++;
            return origDrain.apply(this);
        };

        // The failed create left the file staged but unindexed; size() drains it in and grows the total.
        const healed = await contacts.size();
        expect(drainCalls).toBe(1);
        expect(healed).toBeGreaterThan(sizeBefore);
        expect((await contacts.getContacts()).some((c) => c.firstName === 'Sized')).toBe(true);
    });
});
