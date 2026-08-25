import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '@workspace/lib/types/contact';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { parseVCard } from '../../lib/carddav/vcard-parse';
import { mergeVCard } from '../../lib/carddav/vcard-serialize';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { labelColorFor, normalizeLabelName, uriKeyOf } from '../../lib/contacts/card-store';
import { Contacts } from '../../lib/contacts/contacts';
import { CONTACTS_DB_CONFIG } from '../../lib/contacts/db-config';
import * as contactsSchema from '../../lib/contacts/schema';
import { ManagedDatabase } from '../../lib/core';
import type { Home } from '../../lib/home';
import {
    avatarsDirOf,
    CONTACTS_TEST_ROOT,
    cardsDirOf,
    makeContacts,
    stageAvatar,
    validContact,
} from '../contacts-test-helpers';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

const cardPathOf = (dir: string, uri: string) => join(cardsDirOf(dir), uri);
const parseCount = (contacts: Contacts) => contacts.cardParseCount;
const uriOf = (db: Awaited<ReturnType<typeof makeContacts>>['db'], id: string) =>
    db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!.uri;

// Skipped cards are logged, not thrown — capture the warnings so a test can assert them and the run stays quiet.
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

    test('a planted KIND:group card indexes as a group and stays out of the contact list', async () => {
        const { contacts, db, dir } = await makeContacts();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(
            cardPathOf(dir, 'group.vcf'),
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${randomUUID()}\r\nN:Design Team;;;;\r\nFN:Design Team\r\nKIND:group\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${randomUUID()}\r\nEND:VCARD\r\n`,
        );

        await contacts.init();

        // Indexed (so DAV can serve it and the file is left alone), just never projected to the app.
        const row = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, 'group.vcf'))
            .get()!;
        expect(row.isGroup).toBe(true);
        expect(
            db
                .select()
                .from(contactsSchema.contactTombstones)
                .where(eq(contactsSchema.contactTombstones.uriKey, 'group.vcf'))
                .get(),
        ).toBeUndefined();
        expect(existsSync(cardPathOf(dir, 'group.vcf'))).toBe(true);

        expect((await contacts.getContacts()).some((c) => c.id === row.id)).toBe(false);
        expect(await contacts.getContactById(row.id)).toBeNull();
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

    test('a wiped avatars directory is rebuilt on init for the cards that reference it', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const picId = await contacts.addContact(
            validContact({ firstName: 'Restored', avatar: await stageAvatar(contacts) }),
        );
        await contacts.addContact(validContact({ firstName: 'Plain', email: ['plain@example.com'] }));
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, picId)).get()!;
        const cacheName = (row.data?.avatar ?? '').split('/').pop()!;

        // Restoring cards/ + contacts.db without avatars/: every card file is stat-clean, so only the
        // projection can tell that a derived cache is gone.
        rmSync(avatarsDirOf(dir), { recursive: true, force: true });
        const parsesBefore = parseCount(contacts);

        await contacts.init();

        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(true);
        expect(await contacts.downloadAvatar(cacheName)).not.toBeNull();
        expect((await contacts.getContactById(picId))?.avatar).toBe(`contacts/${user.id}/avatar/${cacheName}`);
        // Only the card whose cache was missing is re-read; the photoless ones stay stat-clean.
        expect(parseCount(contacts) - parsesBefore).toBe(1);
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

    test('a self card whose stat fails keeps the slot from an owner-email twin drifting in the same pass', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const selfUri = uriOf(db, me.id);

        // A transient IO failure hides the self card from the stat pass: its row is deliberately kept alive
        // (never tombstoned), so it must keep holding the self slot too — otherwise the twin drifting in this
        // same pass mints a second eigenId row that no later clean pass can repair.
        writeFileSync(cardPathOf(dir, '0.vcf'), emailTwin(user.email));
        const storage = (
            contacts as unknown as {
                storage: { stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }> };
            }
        ).storage;
        const originalStat = storage.stat;
        storage.stat = async (filePath) => {
            if (filePath === `cards/${selfUri}`) throw new Error('stat boom');
            return originalStat.call(storage, filePath);
        };

        const warnings = await captureWarnings(async () => {
            try {
                await contacts.reconcileIndex();
            } finally {
                storage.stat = originalStat;
            }
        });

        expect(warnings.some((w) => w.includes(selfUri))).toBe(true);
        expect(selfLinkRows(db, user.id)).toEqual([me.id]);
        const twin = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.uriKey, uriKeyOf('0.vcf')))
            .get()!;
        expect(twin.eigenId).toBe('');
        expect(readFileSync(cardPathOf(dir, '0.vcf'), 'utf8')).not.toContain('X-EIGEN-ID');
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

    test('a garbage .vcf never bumps the ctag and is counted on disk by both passes', async () => {
        const { contacts, db, dir } = await makeContacts();
        mkdirSync(cardsDirOf(dir), { recursive: true });
        writeFileSync(cardPathOf(dir, 'garbage.vcf'), 'this is not a vcard at all\r\n');
        const garbageSize = statSync(cardPathOf(dir, 'garbage.vcf')).size;
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        // The file can never be indexed, so it lands in every pass's re-read set forever. Nothing changes in
        // the book, so nothing may tell clients to poll for a change — not on this restart, not on the next.
        await captureWarnings(() => contacts.init());
        const bytesAfterReconcile = await contacts.size();
        await captureWarnings(() => contacts.init());

        expect(db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore);
        expect(await contacts.size()).toBe(bytesAfterReconcile);

        // Both passes answer the same question — how many bytes cards/ holds — so unindexable bytes count in
        // both. Otherwise a rebuild would silently hand the user back quota the files still occupy.
        await captureWarnings(() => contacts.rebuildIndex());
        expect(await contacts.size()).toBe(bytesAfterReconcile);

        // Deleting it gives back exactly its bytes — proof both totals really carried them.
        rmSync(cardPathOf(dir, 'garbage.vcf'));
        await contacts.init();
        expect(await contacts.size()).toBe(bytesAfterReconcile - garbageSize);
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

    test('an unparseable member card is skipped by a label rename instead of bricking every label write', async () => {
        const { contacts, db, dir } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Crew', color: '#abcdef' });
        const goodId = await contacts.addContact(
            validContact({ firstName: 'Good', email: ['good-member@example.com'], labels: [labelId] }),
        );
        const brokenId = await contacts.addContact(
            validContact({ firstName: 'Broken', email: ['broken-member@example.com'], labels: [labelId] }),
        );
        const goodUri = uriOf(db, goodId);
        const brokenUri = uriOf(db, brokenId);

        // Corrupted out of band after it was indexed: nothing re-reads the file, so its junction row survives
        // and the rename fans out to a card that can no longer be parsed.
        const garbage = 'not a vcard anymore\r\n';
        writeFileSync(cardPathOf(dir, brokenUri), garbage);

        const warnings = await captureWarnings(async () => {
            await contacts.updateLabel(labelId, { name: 'Team', color: '#abcdef' });
        });

        // The readable member is renamed, the broken one is left exactly as found and logged.
        expect(parseVCard(readFileSync(cardPathOf(dir, goodUri), 'utf8')).categories).toEqual(['Team']);
        expect(readFileSync(cardPathOf(dir, brokenUri), 'utf8')).toBe(garbage);
        expect(warnings.some((w) => w.includes(brokenUri))).toBe(true);

        // The journal cleared, so no later label mutation replays the doomed fan-out and 500s on it.
        expect(db.select().from(contactsSchema.pendingLabelRenames).all()).toEqual([]);
        await captureWarnings(async () => {
            await contacts.addLabel({ name: 'Later', color: '#abcdef' });
            await contacts.deleteLabel(labelId);
        });
        expect((await contacts.getLabels()).some((l) => l.name === 'Later')).toBe(true);
        expect(await contacts.getContactById(brokenId)).toBeTruthy();
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

// Renaming yourself in Contacts also renames you org-wide, but that push happens after the card is committed:
// it may never turn a saved edit into a reported failure.
describe('self-profile propagation', () => {
    test('a failed profile push still reports the committed self-card edit as saved', async () => {
        const { contacts, broadcasts, db, dir, user } = await makeContacts();
        const me = (await contacts.getMe())!;
        const uri = uriOf(db, me.id);
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, me.id)).get()!;

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
        // The card and its index row committed before the push ran, so the client must be told they did —
        // a reported failure would send the next save back with a stale etag that 412s.
        expect(readFileSync(cardPathOf(dir, uri), 'utf8')).toContain('NOTE:propagation failed');
        const after = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, me.id)).get()!;
        expect(after.firstName).toBe('Augusta');
        expect(after.etag).not.toBe(before.etag);
        expect((await contacts.getContactById(me.id))?.notes).toBe('propagation failed');
        expect(broadcasts.some((e) => e.type === SSEventType.CONTACT_UPDATED)).toBe(true);
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

    test('size() never drains a pending failure — a draining read heals it, then size() reflects it', async () => {
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

        // Spy AFTER the failure so we can prove which read drains.
        let drainCalls = 0;
        const proto = Object.getPrototypeOf(contacts) as { drainDirty: () => Promise<void> };
        const origDrain = proto.drainDirty;
        (contacts as unknown as { drainDirty: () => Promise<void> }).drainDirty = function (this: Contacts) {
            drainCalls++;
            return origDrain.apply(this);
        };

        // size() must NEVER drain: it is reachable from the in-lock quota gate, so draining here would re-enter
        // the non-reentrant write lock and deadlock the home. The pending failure is therefore not healed by
        // size(), and the total is unchanged (the failed create never credited its bytes).
        expect(await contacts.size()).toBe(sizeBefore);
        expect(drainCalls).toBe(0);

        // The next draining read (getContacts) heals the orphan through the shared prepare path; only then does
        // size() grow to include it.
        expect((await contacts.getContacts()).some((c) => c.firstName === 'Sized')).toBe(true);
        expect(drainCalls).toBe(1);
        expect(await contacts.size()).toBeGreaterThan(sizeBefore);
    });
});

// The in-memory dirty set and the in-process rename compensation both die with the process. These pin the
// durable half: the journals in contacts.db, and the recovery init runs off them.
describe('crash recovery (durable journals)', () => {
    // A fresh Contacts over the same home dir and user — a process restart, carrying none of the first
    // instance's in-memory state.
    const restart = async (dir: string, user: Awaited<ReturnType<typeof makeContacts>>['user']) => {
        const managed = new ManagedDatabase(CONTACTS_DB_CONFIG, join(dir, 'eigen.contacts', 'contacts.db'));
        await managed.open(0);
        const home = {
            homeDir: dir,
            user,
            getLocalDatabase: async () => managed,
            broadcast: () => {},
        } as unknown as Home;
        const contacts = new Contacts(home);
        await contacts.init();
        return { contacts, db: managed.db, close: () => managed.close() };
    };

    test('a card write killed before its index commit is re-indexed on init, same stat or not', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Same', email: ['same-crash@example.com'], notes: 'ZZZZ' }),
        );
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

        // The card file writes, then the process dies before the index commit — so the in-memory dirty
        // marker dies with it and only the durable write intent is left.
        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        priv.commitCard = () => {
            throw new Error('commit boom');
        };
        await expect(
            contacts.updateContact(
                id,
                validContact({ firstName: 'Same', email: ['same-crash@example.com'], notes: 'QQQQ' }),
            ),
        ).rejects.toThrow('commit boom');

        // Same-length bytes with the indexed mtime pinned back: the stat-only reconcile is blind to this file.
        utimesSync(cardPathOf(dir, before.uri), new Date(), new Date(before.mtime));
        const stat = statSync(cardPathOf(dir, before.uri));
        expect(Math.round(stat.mtimeMs)).toBe(before.mtime);
        expect(stat.size).toBe(before.size);
        expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([{ uri: before.uri }]);

        const restarted = await restart(dir, user);
        try {
            expect((await restarted.contacts.getContactById(id))?.notes).toBe('QQQQ');
            expect(
                restarted.db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!
                    .etag,
            ).not.toBe(before.etag);
            // The intent is satisfied, so a second restart has nothing to drain.
            expect(restarted.db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
        } finally {
            await restarted.close();
        }
    });

    test('a recovery drain that fails transiently keeps its write intent for the next init', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Retry', email: ['retry-crash@example.com'], notes: 'ZZZZ' }),
        );
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        priv.commitCard = () => {
            throw new Error('commit boom');
        };
        await expect(
            contacts.updateContact(
                id,
                validContact({ firstName: 'Retry', email: ['retry-crash@example.com'], notes: 'QQQQ' }),
            ),
        ).rejects.toThrow('commit boom');

        // Same-length bytes with the indexed mtime pinned back: the journal is the only thing that can find
        // this card, which is exactly why a failed drain may not throw it away.
        utimesSync(cardPathOf(dir, before.uri), new Date(), new Date(before.mtime));
        expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([{ uri: before.uri }]);

        // An IO blip inside the recovery drain: init survives it (a home that cannot open is worse), but the
        // durable intent must outlive it so the next init retries.
        const proto = Object.getPrototypeOf(contacts) as { prepareCardRow: (...args: unknown[]) => Promise<unknown> };
        const originalPrepare = proto.prepareCardRow;
        proto.prepareCardRow = async () => {
            throw new Error('io blip');
        };
        let restarted!: Awaited<ReturnType<typeof restart>>;
        let warnings: string[] = [];
        try {
            warnings = await captureWarnings(async () => {
                restarted = await restart(dir, user);
            });
        } finally {
            proto.prepareCardRow = originalPrepare;
        }

        try {
            expect(warnings.some((w) => w.includes(before.uri))).toBe(true);
            expect((await restarted.contacts.getContactById(id))?.notes).toBe('ZZZZ'); // the stale row survives
            expect(restarted.db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([{ uri: before.uri }]);

            // The next init retries the intent and pays the debt.
            await restarted.contacts.init();
            expect((await restarted.contacts.getContactById(id))?.notes).toBe('QQQQ');
            expect(restarted.db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
        } finally {
            await restarted.close();
        }
    });

    test('a card the reconcile already re-indexed is not drained a second time', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Drift', email: ['drift-crash@example.com'], notes: 'short' }),
        );
        const before = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;

        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        priv.commitCard = () => {
            throw new Error('commit boom');
        };
        await expect(
            contacts.updateContact(
                id,
                validContact({
                    firstName: 'Drift',
                    email: ['drift-crash@example.com'],
                    notes: 'a considerably longer note than the one before it',
                }),
            ),
        ).rejects.toThrow('commit boom');

        // The file grew, so the stat-only reconcile sees the drift and re-indexes the card itself — the
        // recovery drain that follows must find its debt already paid.
        expect(statSync(cardPathOf(dir, before.uri)).size).not.toBe(before.size);
        expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([{ uri: before.uri }]);
        const ctagBefore = db.select().from(contactsSchema.book).get()!.ctag;

        const restarted = await restart(dir, user);
        try {
            expect((await restarted.contacts.getContactById(id))?.notes).toBe(
                'a considerably longer note than the one before it',
            );
            expect(restarted.db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
            // One parse and one ctag bump for the pass — not a second round through the drain, which would
            // send every client into a no-op delta poll per crash recovery.
            expect(restarted.contacts.cardParseCount).toBe(1);
            expect(restarted.db.select().from(contactsSchema.book).get()!.ctag).toBe(ctagBefore + 1);
        } finally {
            await restarted.close();
        }
    });

    test('a rename killed mid-fan-out finishes on init, and a later rebuild changes nothing', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Bandmates', color: '#abcdef' });
        const ids: string[] = [];
        for (const name of ['One', 'Two', 'Three']) {
            ids.push(
                await contacts.addContact(
                    validContact({ firstName: name, email: [`${name.toLowerCase()}@example.com`], labels: [labelId] }),
                ),
            );
        }
        const uris = ids.map((id) => uriOf(db, id));

        // Kill the fan-out after the first member card: every later write throws, and the in-process
        // compensation cannot run either (a killed process rolls nothing back).
        const storage = (
            contacts as unknown as { storage: { writeAtomic: (path: string, bytes: Uint8Array) => Promise<void> } }
        ).storage;
        const originalWrite = storage.writeAtomic;
        let writes = 0;
        storage.writeAtomic = async (path, bytes) => {
            if (++writes > 1) throw new Error('write boom');
            return originalWrite.call(storage, path, bytes);
        };
        const updateSpy = spyOn(db, 'update').mockImplementation(() => {
            throw new Error('compensation killed');
        });
        const origError = console.error;
        console.error = () => {};

        try {
            await expect(contacts.updateLabel(labelId, { name: 'Colleagues', color: '#abcdef' })).rejects.toThrow(
                'write boom',
            );
        } finally {
            storage.writeAtomic = originalWrite;
            updateSpy.mockRestore();
            console.error = origError;
        }

        // The stuck state: the row renamed, one card rewritten, the rest still carrying the old name — all
        // of them stat-clean, so no reconcile can see them.
        expect(db.select().from(contactsSchema.labels).where(eq(contactsSchema.labels.id, labelId)).get()!.name).toBe(
            'Colleagues',
        );
        expect(parseVCard(readFileSync(cardPathOf(dir, uris[0]), 'utf8')).categories).toEqual(['Colleagues']);
        expect(parseVCard(readFileSync(cardPathOf(dir, uris[2]), 'utf8')).categories).toEqual(['Bandmates']);
        expect(db.select().from(contactsSchema.pendingLabelRenames).all()).toEqual([
            { labelId, oldName: 'Bandmates', newName: 'Colleagues' },
        ]);

        const restarted = await restart(dir, user);
        try {
            for (const uri of uris) {
                expect(parseVCard(readFileSync(cardPathOf(dir, uri), 'utf8')).categories).toEqual(['Colleagues']);
            }
            expect(restarted.db.select().from(contactsSchema.pendingLabelRenames).all()).toEqual([]);

            // Junction and label row agree: one label, still the renamed one, still holding all three members.
            const labels = restarted.db.select().from(contactsSchema.labels).all();
            expect(labels.filter((l) => l.nameKey === 'colleagues').map((l) => l.id)).toEqual([labelId]);
            expect(labels.some((l) => l.nameKey === 'bandmates')).toBe(false);
            for (const id of ids) expect((await restarted.contacts.getContactById(id))?.labels).toEqual([labelId]);

            // A rebuild re-derives labels from the files; with the files converged it re-mints nothing.
            await restarted.contacts.rebuildIndex();
            expect(
                restarted.db
                    .select()
                    .from(contactsSchema.labels)
                    .all()
                    .map((l) => l.id)
                    .sort(),
            ).toEqual(labels.map((l) => l.id).sort());
            for (const id of ids) expect((await restarted.contacts.getContactById(id))?.labels).toEqual([labelId]);
        } finally {
            await restarted.close();
        }
    });

    test('a completed rename leaves no journal row behind', async () => {
        const { contacts, db } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Clean', color: '#abcdef' });
        await contacts.addContact(
            validContact({ firstName: 'Member', email: ['clean@example.com'], labels: [labelId] }),
        );

        await contacts.updateLabel(labelId, { name: 'Cleaner', color: '#abcdef' });

        expect(db.select().from(contactsSchema.pendingLabelRenames).all()).toEqual([]);
        expect(db.select().from(contactsSchema.pendingCardWrites).all()).toEqual([]);
    });
});

// Seeding the org owner into a fresh book is one-shot, latched in book.ownerSeeded once a real owner has been
// considered — and only then, so an instance that has no owner yet still seeds the one it gets later.
describe('owner-contact seeding (one-shot latch)', () => {
    const ownerSeededFlag = (db: Awaited<ReturnType<typeof makeContacts>>['db']) =>
        db.select().from(contactsSchema.book).where(eq(contactsSchema.book.id, 1)).get()!.ownerSeeded;

    test('a deleted owner contact stays deleted across a re-init', async () => {
        const { getOrgOwner } = await import('../../lib/user/user');
        const owner = (await getOrgOwner())!;
        const setting = getServerSettings().onboarding.autoAddOwnerContact;
        await updateServerSettings({ onboarding: { autoAddOwnerContact: true } });

        try {
            const { contacts, db } = await makeContacts();
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
            const { contacts, db } = await makeContacts();
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

describe('size() must never re-enter the non-reentrant write lock', () => {
    // Resolve `p` or reject once `ms` elapses — turns a self-deadlock (a promise that never settles) into a
    // failing assertion instead of a hung test run, and clears the timer on the resolve path so no stray
    // rejection leaks.
    const completesWithin = async <T>(p: Promise<T>, ms: number, msg: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(msg)), ms);
        });
        try {
            return await Promise.race([p, timeout]);
        } finally {
            clearTimeout(timer);
        }
    };

    test('size() called from inside the write lock still completes when a lock-free read marked a card dirty', async () => {
        const { contacts } = await makeContacts();
        const priv = contacts as unknown as {
            writeLock: { run<T>(fn: () => Promise<T>): Promise<T> };
            markCardDirty(uri: string): void;
        };

        // getCard's ENOENT branch marks a uri dirty WITHOUT holding the lock — reproduce that state. If it
        // lands between a mutation's drainDirty() and its quota gate, size() sees a non-empty dirty set.
        priv.markCardDirty('ghost.vcf');

        // enforceCardBudget reaches Contacts.size() from INSIDE the write lock on every metered mutation.
        // Reproduce that position: hold the lock, then call size(). If size() drains — taking the same
        // non-reentrant Semaphore(1) it is already inside — it self-deadlocks the whole home forever.
        const sizeFromInsideLock = priv.writeLock.run(() => contacts.size());
        const bytes = await completesWithin(
            sizeFromInsideLock,
            2000,
            'size() self-deadlocked: it re-entered the write lock it was already inside',
        );
        expect(bytes).toBeGreaterThanOrEqual(0);
    });
});
