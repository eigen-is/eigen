import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '@workspace/lib/types/contact';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { mergeVCard } from '../lib/carddav/vcard-serialize';
import { labelColorFor, normalizeLabelName, uriKeyOf } from '../lib/contacts/card-store';
import type { Contacts } from '../lib/contacts/contacts';
import * as contactsSchema from '../lib/contacts/schema';
import { CONTACTS_TEST_ROOT, makeContacts, stageAvatar, validContact } from './contacts-test-helpers';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

const cardsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'cards');
const cardPathOf = (dir: string, uri: string) => join(cardsDirOf(dir), uri);
const avatarsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'avatars');
const parseCount = (contacts: Contacts) => contacts.cardParseCount;
const uriOf = (db: Awaited<ReturnType<typeof makeContacts>>['db'], id: string) =>
    db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.uri;

describe('reconcileIndex (stat-only pass)', () => {
    test('a clean second init re-parses zero files and leaves the ctag untouched', async () => {
        const { contacts, db } = await makeContacts();
        const parsesBefore = parseCount(contacts);
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        await contacts.init();

        expect(parseCount(contacts)).toBe(parsesBefore);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
    });

    test('a cards directory enumeration failure leaves rows, ctag, and tombstones untouched', async () => {
        const { contacts, db } = await makeContacts();
        const keepId = await contacts.addContact(validContact({ firstName: 'Keep', email: ['keep@example.com'] }));
        const goneId = await contacts.addContact(validContact({ firstName: 'Gone', email: ['gone@example.com'] }));
        await contacts.deleteContact(goneId);

        const rowsBefore = db.select().from(contactsSchema.contacts).all();
        const bookBefore = db.select().from(contactsSchema.book).get();
        const tombstonesBefore = db.select().from(contactsSchema.contactTombstones).all();
        const storage = (contacts as unknown as { storage: { readdir: () => Promise<string[]> } }).storage;
        const originalReaddir = storage.readdir;
        storage.readdir = async () => {
            throw new Error('readdir boom');
        };

        try {
            await expect(contacts.reconcileIndex()).rejects.toThrow('readdir boom');
        } finally {
            storage.readdir = originalReaddir;
        }

        expect(db.select().from(contactsSchema.contacts).all()).toEqual(rowsBefore);
        expect(db.select().from(contactsSchema.book).get()).toEqual(bookBefore);
        expect(db.select().from(contactsSchema.contactTombstones).all()).toEqual(tombstonesBefore);
        expect((await contacts.getContactById(keepId))?.firstName).toBe('Keep');
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

    test('a card re-planted at a deleted uri clears its tombstone on reconcile', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Reborn', email: ['reborn@example.com'] }));
        const uri = uriOf(db, id);

        await contacts.deleteContact(id);
        // The delete leaves a live tombstone for that uriKey and removes the card file.
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uriKey, uriKeyOf(uri)))
                .get(),
        ).toBeTruthy();

        // A device re-adds a card FILE at the very same uri — it is alive again, not a lingering removal.
        writeFileSync(
            cardPathOf(dir, uri),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${randomUUID()}\r\nN:Reborn;Again;;;\r\nFN:Again Reborn\r\nEMAIL:reborn@example.com\r\nEND:VCARD\r\n`,
        );

        await contacts.init();

        // The present file re-indexes AND its stale tombstone is cleared by the folded uriKey.
        expect(
            db
                .select()
                .from(contactsSchema.contacts)
                .where(eq(contactsSchema.contacts.uriKey, uriKeyOf(uri)))
                .get(),
        ).toBeTruthy();
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uriKey, uriKeyOf(uri)))
                .get(),
        ).toBeUndefined();
    });

    test('a delete + case-variant recreate refreshes the stored uri so reads still resolve', async () => {
        const { contacts, db, dir } = await makeContacts();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        const uid = randomUUID();
        const card = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nN:Case;Variant;;;\r\nFN:Variant Case\r\nEMAIL:cv@example.com\r\nEND:VCARD\r\n`;
        writeFileSync(cardPathOf(dir, 'A.vcf'), card);
        await contacts.init();
        const before = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, 'a.vcf'))
            .get()!;
        expect(before.uri).toBe('A.vcf');

        // Delete A.vcf and recreate the same content + UID at the case-variant a.vcf. Without refreshing the
        // stored uri, the row keeps pointing at A.vcf and every later read ENOENTs on a case-sensitive FS.
        rmSync(cardPathOf(dir, 'A.vcf'));
        writeFileSync(cardPathOf(dir, 'a.vcf'), card);
        const future = new Date(Date.now() + 5000);
        utimesSync(cardPathOf(dir, 'a.vcf'), future, future); // force a stat drift so reconcile re-reads it
        await contacts.init();

        const after = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, 'a.vcf'))
            .get()!;
        expect(after.id).toBe(before.id); // same contact, updated in place
        expect(after.uri).toBe('a.vcf'); // uri refreshed to the on-disk name
        expect((await contacts.getContactById(after.id))?.firstName).toBe('Variant');
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

    test('a deleted self card lets an owner-email twin claim the slot without duplicating me', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const selfUri = uriOf(db, me.id);

        // Plant an owner-email twin, then delete the self card's file out-of-band so the self row is tombstoned
        // this same pass. The twin must be free to claim the slot — the self row being removed cannot count as
        // a "surviving self" that blocks it.
        writeFileSync(cardPathOf(dir, 'twin.vcf'), emailTwin(user.email));
        rmSync(cardPathOf(dir, selfUri));

        await contacts.init();

        const selfRows = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .all();
        expect(selfRows.length).toBe(1);
        const twin = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('twin.vcf')))
            .get()!;
        expect(twin.eigenId).toBe(user.id);
        expect(readFileSync(cardPathOf(dir, 'twin.vcf'), 'utf8')).toContain(`X-EIGEN-ID:${user.id}`);
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

// Init must survive a hostile cards/ directory: a garbage file, a file that vanishes mid-pass, or two files
// claiming one UID can never brick the whole account (spec § 1 — one bad card is skipped-and-logged, not fatal).
describe('per-file fault tolerance', () => {
    const captureWarnings = async (fn: () => Promise<void>): Promise<string[]> => {
        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
        try {
            await fn();
        } finally {
            console.warn = origWarn;
        }
        return warnings;
    };

    test('a garbage .vcf is skipped and logged while a valid card still indexes', async () => {
        const { contacts, dir } = await makeContacts();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(cardPathOf(dir, 'garbage.vcf'), 'this is not a vcard at all\r\n');
        const goodId = randomUUID();
        writeFileSync(
            cardPathOf(dir, 'good.vcf'),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${goodId}\r\nN:Real;Ada;;;\r\nFN:Ada Real\r\nEMAIL:ada2@example.com\r\nEND:VCARD\r\n`,
        );

        const warnings = await captureWarnings(() => contacts.init());

        expect((await contacts.getContacts()).some((c) => c.firstName === 'Ada' && c.lastName === 'Real')).toBe(true);
        // The garbage file is invisible-but-logged and left on disk, not deleted.
        expect(existsSync(cardPathOf(dir, 'garbage.vcf'))).toBe(true);
        expect(warnings.some((w) => w.includes('garbage.vcf'))).toBe(true);
    });

    test('two card files sharing a UID index the first by uri and skip the second', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Twin', email: ['twin@example.com'] }));
        const uri = uriOf(db, id);
        const uid = parseVCard(readFileSync(cardPathOf(dir, uri), 'utf8')).uid!;

        // A byte-for-byte copy at a lexically-later name → a second file carrying the same UID.
        const twinUri = `zzz-${uri}`;
        writeFileSync(cardPathOf(dir, twinUri), readFileSync(cardPathOf(dir, uri), 'utf8'));

        const warnings = await captureWarnings(() => contacts.init());

        const withUid = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.uid, uid)).all();
        expect(withUid.length).toBe(1);
        expect(withUid[0].uriKey).toBe(uriKeyOf(uri));
        // The loser is never indexed and its file is untouched.
        expect(existsSync(cardPathOf(dir, twinUri))).toBe(true);
        expect(warnings.some((w) => w.toUpperCase().includes('UID'))).toBe(true);
    });

    test('a same-UID copy planted at an earlier name while the original drifts does not brick init', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Keep', email: ['keep@example.com'] }));
        const uri = uriOf(db, id);
        const uid = parseVCard(readFileSync(cardPathOf(dir, uri), 'utf8')).uid!;

        // Drift the original so it re-indexes this pass, then drop a byte-copy carrying the same UID at a
        // lexically-EARLIER name so it is visited first. The incumbent still owns the uid, so seeding the
        // collision guard with every surviving row (not just the untouched ones) keeps the copy from tripping
        // the UNIQUE index inside the transaction and bricking the whole account.
        const future = new Date(Date.now() + 5000);
        utimesSync(cardPathOf(dir, uri), future, future);
        const earlierUri = '0-collision.vcf';
        expect(earlierUri < uri).toBe(true);
        writeFileSync(cardPathOf(dir, earlierUri), readFileSync(cardPathOf(dir, uri), 'utf8'));

        const warnings = await captureWarnings(() => contacts.init());

        // Init survived, exactly one row owns the uid, and it is the incumbent (not the earlier-sorting copy).
        const withUid = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.uid, uid)).all();
        expect(withUid.length).toBe(1);
        expect(withUid[0].id).toBe(id);
        expect(warnings.some((w) => w.toUpperCase().includes('UID'))).toBe(true);
    });
});

// The app sends birthdays as bare dates; the seam also normalizes external ISO datetime input so files stay
// the source of truth and echoing a phone's BDAY remains a no-op.
describe('birthday normalization at the seam', () => {
    test('addContact stores a date-only birthday as a date BDAY and round-trips it', async () => {
        const { contacts, dir } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Born', email: ['born@example.com'], birthday: '1990-01-01' }),
        );

        expect(readFileSync(cardPathOf(dir, `${id}.vcf`), 'utf8')).toContain('BDAY:1990-01-01');
        expect((await contacts.getContactById(id))?.birthday).toBe('1990-01-01');
        await contacts.rebuildIndex();
        expect((await contacts.getContactById(id))?.birthday).toBe('1990-01-01');
    });

    test('external ISO input keeps its date prefix verbatim instead of shifting by timezone', async () => {
        const { contacts, dir } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Eve', email: ['eve@example.com'], birthday: '1989-12-31T22:00:00.000Z' }),
        );

        expect(readFileSync(cardPathOf(dir, `${id}.vcf`), 'utf8')).toContain('BDAY:1989-12-31');
        expect((await contacts.getContactById(id))?.birthday).toBe('1989-12-31');
    });

    test('updateContact echoing a phone-synced BDAY leaves the BDAY line untouched', async () => {
        const { contacts, db, dir } = await makeContacts();
        const cardId = randomUUID();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(
            cardPathOf(dir, 'phone.vcf'),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${cardId}\r\nN:Sync;Phone;;;\r\nFN:Phone Sync\r\nEMAIL:phone@example.com\r\nBDAY:19731003\r\nEND:VCARD\r\n`,
        );
        await contacts.init();
        const row = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('phone.vcf')))
            .get()!;
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

        expect(readFileSync(cardPathOf(dir, 'phone.vcf'), 'utf8')).toContain('BDAY:19731003');
    });
});

describe('canonical file operation failures', () => {
    test('a non-ENOENT unlink failure leaves the row, ctag, tombstones, and file untouched', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Keep', email: ['keep-unlink@example.com'] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        const tombstonesBefore = db.select().from(contactsSchema.contactTombstones).all();
        const storage = (contacts as unknown as { storage: { unlink: (filePath: string) => Promise<void> } }).storage;
        const originalUnlink = storage.unlink;
        storage.unlink = async () => {
            throw Object.assign(new Error('unlink boom'), { code: 'EIO' });
        };

        try {
            await expect(contacts.deleteContact(id)).rejects.toThrow('unlink boom');
        } finally {
            storage.unlink = originalUnlink;
        }

        expect(existsSync(cardPathOf(dir, row.uri))).toBe(true);
        expect(db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()).toEqual(row);
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
        expect(db.select().from(contactsSchema.contactTombstones).all()).toEqual(tombstonesBefore);
    });

    test('a missing canonical file is treated as already deleted', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Gone', email: ['gone-file@example.com'] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;
        rmSync(cardPathOf(dir, row.uri));

        await contacts.deleteContact(id);

        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get(),
        ).toBeUndefined();
        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore + 1);
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uri, row.uri))
                .get(),
        ).toBeTruthy();
    });

    test('an update post-rename stat failure heals the changed file on the next read', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Before', email: ['before@example.com'] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const storage = (
            contacts as unknown as {
                storage: { stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }> };
            }
        ).storage;
        const originalStat = storage.stat;
        let failed = false;
        storage.stat = async (filePath) => {
            if (!failed && filePath === `cards/${row.uri}`) {
                failed = true;
                throw new Error('stat boom');
            }
            return originalStat.call(storage, filePath);
        };

        try {
            await expect(
                contacts.updateContact(
                    id,
                    validContact({ firstName: 'After', email: ['before@example.com'], notes: 'post-rename update' }),
                ),
            ).rejects.toThrow('stat boom');
        } finally {
            storage.stat = originalStat;
        }

        expect(readFileSync(cardPathOf(dir, row.uri), 'utf8')).toContain('NOTE:post-rename update');
        expect((await contacts.getContactById(id))?.firstName).toBe('After');
        expect((await contacts.getContactById(id))?.notes).toBe('post-rename update');
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.etag,
        ).not.toBe(row.etag);
    });

    test('a create post-rename stat failure heals the orphaned file on the next read', async () => {
        const { contacts, dir } = await makeContacts();
        const cardsDir = cardsDirOf(dir);
        const filesBefore = new Set(readdirSync(cardsDir));
        const storage = (
            contacts as unknown as {
                storage: { stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }> };
            }
        ).storage;
        const originalStat = storage.stat;
        let failed = false;
        storage.stat = async (filePath) => {
            if (!failed && filePath.startsWith('cards/')) {
                failed = true;
                throw new Error('stat boom');
            }
            return originalStat.call(storage, filePath);
        };

        try {
            await expect(
                contacts.addContact(validContact({ firstName: 'Orphan', email: ['orphan-stat@example.com'] })),
            ).rejects.toThrow('stat boom');
        } finally {
            storage.stat = originalStat;
        }

        const orphanUri = readdirSync(cardsDir).find((name) => !filesBefore.has(name));
        expect(orphanUri).toBeTruthy();
        expect(readFileSync(cardPathOf(dir, orphanUri!), 'utf8')).toContain('FN:Orphan Lovelace');
        expect((await contacts.getContacts()).some((contact) => contact.firstName === 'Orphan')).toBe(true);
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
