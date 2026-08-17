import { randomUUID } from 'node:crypto';
import type { Address, Contact, CreateContactInput } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import type { ParsedCard, ParsedCardPhoto } from '../carddav/vcard-parse';
import { normalizeBirthday, parseVCard } from '../carddav/vcard-parse';
import { type CardEdits, createVCard, mergeVCard } from '../carddav/vcard-serialize';
import { enforceContactsIngest } from '../config/enforcement';
import { getServerSettings } from '../config/server-settings';
import type { ManagedDatabase } from '../core';
import { ApiError, DEFAULT_LABELS, LocalFilesystem, PATHS } from '../core';
import type { Home } from '../home';
import { atHome, getHome } from '../home';
import { pushUserProfile } from '../home/home-relay';
import type { User } from '../user';
import { getOrgOwner } from '../user/';
import type { StagedAvatarPair } from './avatars';
import * as avatars from './avatars';
import {
    CARD_MAX_BYTES,
    CARDS_DIR,
    cardPath,
    cleanupTempCardFiles,
    computeCardEtag,
    isCardPhotoCacheOf,
    labelColorFor,
    normalizeLabelName,
    uriKeyOf,
    writeCardFile,
} from './card-store';
import type { CardBook, CardRow, DeleteCardResult, PutCardResult } from './dav-store';
import * as davStore from './dav-store';
import { CONTACTS_DB_CONFIG } from './db-config';
import * as labels from './labels';
import * as reconcile from './reconcile';
import * as schema from './schema';
import { buildContactEvent, buildLabelEvent } from './sse-events';

export async function getContacts(user: User): Promise<Contacts> {
    const home = await getHome(user.id);
    return home.contacts;
}

async function getContactsDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB);
}

// The transaction handle drizzle hands a `db.transaction(cb)` callback.
type Tx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

// The columns a card (re)index computes; the ctag + timestamps are stamped inside the write transaction.
export type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;

// The index-stored projection: the owned properties minus what lives in dedicated columns (names/eigenId)
// or the junction (labels). `avatar` is the cache URL only — inline photo bytes never enter the index.
type CardData = NonNullable<(typeof schema.contacts.$inferSelect)['data']>;

// Optionals collapse to '' / [] so this emits the exact same canonical shape prepareCardRow does — the
// update seam's `avatarChanged` diff (and any projection compare) then can't misfire on `undefined !== ''`.
function toData(contact: CreateContactInput): CardData {
    return {
        email: contact.email,
        phone: contact.phone,
        company: contact.company ?? '',
        jobTitle: contact.jobTitle ?? '',
        address: contact.address ?? [],
        birthday: contact.birthday ?? '',
        notes: contact.notes ?? '',
        avatar: contact.avatar ?? '',
    };
}

// What a row whose `data` column is NULL reads as — a pre-projection row, or one a torn write left bare.
// Derived from toData so the fallback can never drift from the shape every write stores.
const EMPTY_CARD_DATA: CardData = toData({ firstName: '', lastName: '', email: [], phone: [] });

function isBlankAddress(a: Address): boolean {
    return (
        !(a.street ?? '').trim() &&
        !(a.city ?? '').trim() &&
        !(a.state ?? '').trim() &&
        !(a.zipCode ?? '').trim() &&
        !(a.country ?? '').trim()
    );
}

// What every REST body passes through at the write seam, in place. The birthday is normalized to a bare date
// so both writers (createVCard + toData) agree and an app-set ISO datetime reaches the file as a plain BDAY;
// the web form's placeholder blank email/phone/address (emptyContact) are dropped so no card carries a bare
// EMAIL:/TEL:/ADR: line out to DAV clients.
function normalizeContactInput(contact: CreateContactInput): void {
    contact.birthday = normalizeBirthday(contact.birthday ?? '');
    contact.email = contact.email.filter((e) => e.trim() !== '');
    contact.phone = contact.phone.filter((p) => p.trim() !== '');
    contact.address = (contact.address ?? []).filter((a) => !isBlankAddress(a));
}

export class Contacts {
    private managedDb!: ManagedDatabase<typeof schema>;
    db!: BunSQLiteDatabase<typeof schema>; // internal — used by contacts/*.ts
    home: Home; // internal — used by contacts/*.ts
    storage: LocalFilesystem; // internal — used by contacts/*.ts

    // All card mutations (REST and, later, DAV) serialize through one slot so a file write and its index
    // commit stay a pair and etag preconditions are evaluated against the state they'll overwrite (spec § 3).
    writeLock = new Semaphore(1); // internal — used by contacts/*.ts

    // A card whose file wrote but whose index commit threw lands here; the next public call (mutation OR read)
    // re-indexes it before it observes the index (fail-closed, spec § 1) — see `ensureDrained`/`drainDirty`.
    // Process death takes this set with it, which is what `pending_card_writes` is for (`recoverPendingWork`).
    private dirtyCards = new Set<string>();

    // Backs `cardParseCount`, the spec's performance-invariant test hook: only the reconcile/rebuild/drain
    // machinery bumps this (via `parseCardFile`); the mutation paths parse for their own merges.
    private cardParses = 0;

    // Running byte totals so size() answers from memory — enforceContactsIngest calls it on every metered
    // write, and a directory walk per call would make an N-card device sync O(N²) stats (spec Performance
    // invariants).
    cardsBytes = 0; // internal — used by contacts/*.ts
    avatarsBytes = 0; // internal — used by contacts/*.ts

    // Whether card writes are quota-metered — see the assignment in init() for what turns it on.
    private meteredIngest = false;

    constructor(home: Home) {
        this.home = home;
        this.storage = new LocalFilesystem(`${home.homeDir}/${PATHS.CONTACTS.ROOT}`);
    }

    // internal — used by contacts/*.ts
    emitContact(type: Parameters<typeof buildContactEvent>[0], contactId: string): void {
        this.home.broadcast(buildContactEvent(type, contactId));
    }

    // internal — used by contacts/*.ts
    emitLabel(type: Parameters<typeof buildLabelEvent>[0], labelId: string): void {
        this.home.broadcast(buildLabelEvent(type, labelId));
    }

    public async init(): Promise<void> {
        this.managedDb = await getContactsDatabase(this.home);
        this.db = this.managedDb.db;

        await this.storage.mkdir(CARDS_DIR);
        await cleanupTempCardFiles(this.storage);

        // Seed the avatar byte total from disk once; every avatar write/delete adjusts it by delta thereafter.
        // cardsBytes is owned by the reconcile/rebuild pass below (both sum every card file cards/ holds,
        // including the ones neither pass could index).
        this.avatarsBytes = await this.storage.dirSize(PATHS.CONTACTS.AVATARS);

        // Bring the index in line with cards/ before seeding: a stat-only reconcile on a healthy book, or a
        // full rebuild if the book/sync bookkeeping is gone (rebuild re-derives it from the files).
        if (this.indexIsIntact()) await this.reconcileIndex();
        else await this.rebuildIndex();

        // Then finish what a crash left half-applied. Runs after the index pass (which guarantees the book
        // row the ctag bumps need) and before anything is served.
        await this.writeLock.run(() => this.recoverPendingWork());

        // Each seed is guarded independently: a crash between them no longer skips a later one forever (spec § 3).
        const existingLabels = this.db.select().from(schema.labels).all();
        if (existingLabels.length === 0) {
            for (const label of DEFAULT_LABELS) {
                this.db
                    .insert(schema.labels)
                    .values({
                        id: randomUUID(),
                        name: label.name,
                        nameKey: normalizeLabelName(label.name),
                        color: label.color,
                    })
                    .run();
            }
        }

        if (!this.selfRow()) {
            await this.addYourself();
        }

        const settings = getServerSettings();
        const bookRow = this.db.select().from(schema.book).where(eq(schema.book.id, 1)).get();
        if (settings.onboarding.autoAddOwnerContact && bookRow && !bookRow.ownerSeeded) {
            const owner = await getOrgOwner();
            if (owner) {
                if (owner.id !== this.home.user.id && !this.hasContactWithEmail(owner.email)) {
                    const [firstName, ...rest] = (owner.name || '').split(' ');
                    await this.addContact({
                        eigenId: owner.id,
                        firstName: firstName || '',
                        lastName: rest.join(' '),
                        email: [owner.email],
                        phone: [],
                        company: '',
                        jobTitle: '',
                        address: [],
                        birthday: '',
                        notes: '',
                        avatar: '',
                        labels: [],
                    });
                }
                // Latch the one-shot seed once a real owner has been considered (added, already present, or
                // self): a later deliberate delete of the owner contact then stays deleted instead of
                // resurrecting on every init. Left unlatched while no owner exists so a later-configured owner
                // can still seed once.
                this.db.update(schema.book).set({ ownerSeeded: 1 }).where(eq(schema.book.id, 1)).run();
            }
        }

        // Ingest metering starts here. Everything written before this point is init's own seed (the self card,
        // the org owner's) and has no quota to resolve yet: the lookup goes through getHome, which during this
        // home's init would await the very init doing the write. An unregistered home — an isolated Contacts
        // in a test harness or a seeding script — has no home to resolve at all and stays unmetered; the
        // CARD_MAX_BYTES ceiling still applies to every card either way.
        this.meteredIngest = atHome(this.home.user.id);

        this.cleanupAvatarImages().catch(() => {});
    }

    // Answered purely from the in-memory byte counters, and it must NEVER take the write lock. enforceCardBudget
    // reaches size() through the mail+contacts quota gate from INSIDE the write lock on every metered mutation,
    // and a lock-free read (getCard's ENOENT branch) can mark a card dirty without holding the lock — draining
    // here would re-acquire the non-reentrant Semaphore(1) this call is already inside and deadlock the home.
    // The counters stay live on every mutation (a pending drain perturbs them by at most one card's delta) and
    // the quota is soft, so it answers directly. Stays async to leave the read-seam signature its callers await.
    public async size(): Promise<number> {
        return this.cardsBytes + this.avatarsBytes;
    }

    // UPDATE book SET ctag = ctag + 1 and read the new value back — matches the calendar bookkeeping.
    // internal — used by contacts/*.ts
    bumpCtag(tx: Tx): number {
        tx.update(schema.book)
            .set({ ctag: sql`${schema.book.ctag} + 1` })
            .where(eq(schema.book.id, 1))
            .run();
        return tx.select({ ctag: schema.book.ctag }).from(schema.book).where(eq(schema.book.id, 1)).get()!.ctag;
    }

    // Upsert a removal tombstone keyed by uri (carrying the folded uriKey so a re-created case-variant card
    // clears it), stamped with the current ctag. One shape shared by drainDirty, reconcile and deleteContact.
    // internal — used by contacts/*.ts
    tombstone(tx: Tx, uri: string, uriKey: string, ctag: number): void {
        tx.insert(schema.contactTombstones)
            .values({ uri, uriKey, deletedAtCtag: ctag })
            .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
            .run();
    }

    // internal — used by contacts/*.ts
    readCardBytes(uri: string): Promise<Uint8Array> {
        return this.storage.file(cardPath(uri)).bytes();
    }

    // Rebuild a card's label junction from its CATEGORIES inside `tx`: each name resolves to a label by
    // nameKey, minting one with its deterministic color when absent (new ids collected so the caller can
    // emit LABEL_CREATED after the transaction). Shared by commitCard and the reconcile/rebuild passes.
    // internal — used by contacts/*.ts
    syncCardLabels(tx: Tx, contactId: string, categories: string[], createdLabelIds: string[]): void {
        const labelIds = new Set<string>();
        for (const name of categories) {
            const nameKey = normalizeLabelName(name);
            if (!nameKey) continue;
            const existing = tx
                .select({ id: schema.labels.id })
                .from(schema.labels)
                .where(eq(schema.labels.nameKey, nameKey))
                .get();
            if (existing) {
                labelIds.add(existing.id);
            } else {
                const id = randomUUID();
                tx.insert(schema.labels)
                    .values({ id, name: name.trim(), nameKey, color: labelColorFor(nameKey) })
                    .run();
                createdLabelIds.push(id);
                labelIds.add(id);
            }
        }

        tx.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, contactId)).run();
        for (const labelId of labelIds) {
            tx.insert(schema.contactsToLabels).values({ contactId, labelId }).run();
        }
    }

    // A clean stat-only reconcile must re-parse nothing (spec Performance invariants); the tests assert this
    // counter stays flat across a second init over an unchanged book.
    public get cardParseCount(): number {
        return this.cardParses;
    }

    // Count every card-file parse the reconcile/rebuild/drain machinery does.
    private parseCardFile(bytes: Uint8Array) {
        this.cardParses++;
        return parseVCard(new TextDecoder().decode(bytes));
    }

    // The single index-write seam: one transaction that stamps the fresh ctag, upserts the row, rebuilds the
    // label junction from the card's CATEGORIES (auto-creating labels by nameKey), and clears any tombstone.
    // internal — used by contacts/*.ts
    commitCard(opts: { row: CardRowInput; categories: string[]; tombstoneCleared?: boolean }): void {
        const createdLabelIds: string[] = [];
        this.db.transaction((tx) => {
            const ctag = this.bumpCtag(tx);

            tx.insert(schema.contacts)
                .values({ ...opts.row, cardCtag: ctag })
                .onConflictDoUpdate({
                    target: schema.contacts.id,
                    set: {
                        // uri/uriKey/uid follow the file (a re-created card at a case-variant uri keeps the id
                        // but moves on disk); eigenId is deliberately omitted — the self-link is managed only by
                        // resolveSelfLink and the reconcile rematch (§ 2 trust rule), never a blind upsert.
                        uri: opts.row.uri,
                        uriKey: opts.row.uriKey,
                        uid: opts.row.uid,
                        firstName: opts.row.firstName,
                        lastName: opts.row.lastName,
                        isGroup: opts.row.isGroup,
                        data: opts.row.data,
                        etag: opts.row.etag,
                        cardCtag: ctag,
                        mtime: opts.row.mtime,
                        size: opts.row.size,
                        updatedAt: sql`unixepoch()`,
                    },
                })
                .run();

            this.syncCardLabels(tx, opts.row.id, opts.categories, createdLabelIds);

            if (opts.tombstoneCleared) {
                // Clear by the folded key so a re-created card at a case-variant uri still clears its own
                // tombstone rather than leaving a stale removal in the sync log.
                tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uriKey, opts.row.uriKey)).run();
            }

            // The pair is complete: the write intent recorded before the file rename is settled here, in the
            // very transaction that settles it — a crash anywhere earlier leaves the row for init to drain.
            tx.delete(schema.pendingCardWrites).where(eq(schema.pendingCardWrites.uri, opts.row.uri)).run();
        });

        for (const id of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, id);
    }

    // A commit that threw after its file was already persisted left the index behind that file. Re-read the
    // recorded uris and re-commit each (or tombstone a vanished one) before the caller reads the index. Runs
    // inside the caller's writeLock.
    // internal — used by contacts/*.ts
    async drainDirty(): Promise<void> {
        if (this.dirtyCards.size === 0) return;
        for (const uri of [...this.dirtyCards]) {
            const existing = this.db
                .select()
                .from(schema.contacts)
                .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
                .get();
            if (await this.storage.exists(cardPath(uri))) {
                // Re-index through the shared prepare path so the healed row gets the canonical projection
                // shape and a regenerated photo cache. commitCard's UPDATE set omits eigenId (§ 2 trust rule),
                // so this value drives only a freshly-INSERTED row; an incumbent's self-link rides through the
                // omission untouched, which is why ranking against the incumbent here would be dead code.
                const prep = await this.prepareCardRow(uri, existing?.id ?? randomUUID(), existing?.uid);
                prep.row.eigenId = this.resolveSelfLink(prep.parsed.eigenId ?? undefined);
                // A present file is alive: commitCard clears any live tombstone for its uri (by uriKey), so a
                // card re-planted at a deleted uri drops its stale removal instead of resurrecting it.
                this.commitCard({ row: prep.row, categories: prep.categories, tombstoneCleared: true });
                this.cardsBytes += prep.row.size - (existing?.size ?? 0);
            } else if (existing) {
                this.db.transaction((tx) => {
                    const ctag = this.bumpCtag(tx);
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, existing.id)).run();
                    this.tombstone(tx, uri, uriKeyOf(uri), ctag);
                });
                this.cardsBytes -= existing.size;
            }
            // Both markers clear together — commitCard already dropped the durable one for a re-indexed card,
            // this covers the tombstoned and the nothing-left-to-do branches.
            this.clearCardWrite(uri);
            this.dirtyCards.delete(uri);
        }
    }

    // internal — used by contacts/*.ts
    markCardDirty(uri: string): void {
        this.dirtyCards.add(uri);
    }

    // Durable write intent, recorded before a card file is written: while it exists, the index owes that uri
    // a commit. commitCard clears it inside the transaction that pays the debt.
    // internal — used by contacts/*.ts
    recordCardWrite(uri: string): void {
        this.db.insert(schema.pendingCardWrites).values({ uri }).onConflictDoNothing().run();
    }

    private clearCardWrite(uri: string): void {
        this.db.delete(schema.pendingCardWrites).where(eq(schema.pendingCardWrites.uri, uri)).run();
    }

    // Init's recovery seam: finish the work a process death cut in half. Every surviving write intent drains
    // exactly as an in-process failure does — one uri per pass, so a failure is isolated to its own card —
    // then any interrupted label rename resumes. Neither half may be fatal: a home whose init throws is a
    // home the user cannot open at all, so an unrecoverable card is dropped with a warning and left on disk
    // for the next reconcile (spec § 1: one bad card is never fatal), and a rename that cannot finish stays
    // recorded for the next label mutation to retry. Caller holds the writeLock.
    private async recoverPendingWork(): Promise<void> {
        for (const { uri } of this.db.select().from(schema.pendingCardWrites).all()) {
            this.markCardDirty(uri);
            try {
                await this.drainDirty();
            } catch (e) {
                // Only the in-memory marker goes, so init survives and later reads aren't gated on a card that
                // cannot be indexed. The durable intent stays: a same-stat rewrite is invisible to every other
                // pass, so forfeiting it on a transient failure would strand the stale row until a rebuild.
                console.warn(`contacts: could not recover the pending write of ${uri}: ${e}`);
                this.dirtyCards.delete(uri);
            }
        }

        try {
            await this.resumeLabelRenames();
        } catch (e) {
            console.warn(`contacts: could not resume a pending label rename: ${e}`);
        }
    }

    // Fail-closed read/mutation guard: a card whose file wrote but whose index commit threw must be re-indexed
    // before it is observed (spec § 1 — no read is served past a failed pair). Free on the hot path — an empty
    // set takes no lock and touches no file; only a pending failure drains, inside the lock, and rethrows if the
    // re-index can't complete. Mutations already drain inside their own lock, so only lock-free reads call this.
    // internal — used by contacts/*.ts
    async ensureDrained(): Promise<void> {
        if (this.dirtyCards.size) await this.writeLock.run(() => this.drainDirty());
    }

    // The book/sync bookkeeping is authoritative in the DB, not derivable from cards/; a missing book row means
    // the index needs a from-scratch rebuild rather than a reconcile.
    private indexIsIntact(): boolean {
        try {
            return !!this.db.select().from(schema.book).where(eq(schema.book.id, 1)).get();
        } catch {
            return false;
        }
    }

    // Read one card file into the index row + label names to (re)commit for it, regenerating a missing
    // inline-photo cache. The self-link is left `''` here and assigned to the single ranked
    // winner afterwards (see `selfClaimRank`/`applySelfLink`) so no loser is ever written or indexed as self.
    // `id` is the stable contact id (an existing row's or a fresh one), `existingUid` the uid fallback.
    // internal — used by contacts/*.ts
    async prepareCardRow(
        uri: string,
        id: string,
        existingUid: string | undefined,
    ): Promise<{ row: CardRowInput; categories: string[]; parsed: ParsedCard }> {
        const bytes = new Uint8Array(await this.storage.file(cardPath(uri)).arrayBuffer());
        const parsed = this.parseCardFile(bytes);

        // The projection avatar is the derived cache URL; regenerate it only when the file has an inline photo
        // whose hashed cache file is missing (out-of-band drift / a rebuild after a cache wipe).
        const avatar = await this.deriveCardPhotoCache(id, parsed.photo);

        const stat = await this.storage.stat(cardPath(uri));
        return {
            row: {
                id,
                uri,
                uriKey: uriKeyOf(uri),
                uid: parsed.uid ?? existingUid ?? randomUUID(),
                firstName: parsed.firstName.trim(),
                lastName: parsed.lastName.trim(),
                eigenId: '',
                isGroup: parsed.isGroup,
                data: {
                    email: parsed.email,
                    phone: parsed.phone,
                    company: parsed.company,
                    jobTitle: parsed.jobTitle,
                    address: parsed.address,
                    birthday: parsed.birthday,
                    notes: parsed.notes,
                    avatar,
                },
                etag: computeCardEtag(bytes),
                mtime: Math.round(stat.mtimeMs),
                size: stat.size,
            },
            categories: parsed.categories,
            parsed,
        };
    }

    // ---- Reconcile facade — implementation in contacts/reconcile.ts ----

    public async reconcileIndex(): Promise<void> {
        return reconcile.reconcileIndex(this);
    }

    public async rebuildIndex(): Promise<void> {
        return reconcile.rebuildIndex(this);
    }

    // Only self-linkable when the caller-supplied id is this user's AND no row already claims it — at most one
    // row carries eigenId = user.id (spec § 2 trust rule). The X-EIGEN-ID stays in the FILE regardless.
    private resolveSelfLink(eigenId: string | undefined): string {
        if (!eigenId || eigenId !== this.home.user.id) return '';
        const claimed = this.db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.eigenId, this.home.user.id))
            .get();
        return claimed ? '' : eigenId;
    }

    // What a card must fit through before it is written: the 5 MiB resource ceiling (spec § 4 — it bounds
    // what a device sync and every later reconcile has to parse) and the mail+contacts quota, credited with
    // the bytes of the card this one replaces. Called inside the writeLock, after the index is drained (so
    // the size() behind the quota lookup can't re-enter the lock) and before any write intent is recorded —
    // a refusal leaves nothing on disk and nothing for a drain to chase.
    // internal — used by contacts/*.ts
    async enforceCardBudget(bytes: Uint8Array, creditBytes: number): Promise<void> {
        if (bytes.byteLength > CARD_MAX_BYTES) {
            throw new ApiError(413, 'Contact card is too large');
        }
        if (this.meteredIngest) {
            await enforceContactsIngest(this.home.user.id, bytes.byteLength, creditBytes);
        }
    }

    private labelNamesFor(labelIds: string[]): string[] {
        return labels.labelNamesFor(this, labelIds);
    }

    public async addContact(contact: CreateContactInput): Promise<string> {
        return this.writeLock.run(async () => {
            await this.drainDirty();
            normalizeContactInput(contact);

            const id = randomUUID();
            const uri = `${id}.vcf`;
            const categories = this.labelNamesFor(contact.labels ?? []);
            // resolveStagedAvatar throws when a non-empty avatar can't be resolved (its staged file was swept),
            // so a create with a vanished upload fails here rather than silently dropping the photo.
            const staged = await this.resolveStagedAvatar(contact.avatar);

            const bytes = new TextEncoder().encode(
                createVCard(
                    {
                        firstName: contact.firstName.trim(),
                        lastName: contact.lastName.trim(),
                        email: contact.email,
                        phone: contact.phone,
                        company: contact.company,
                        jobTitle: contact.jobTitle,
                        address: contact.address,
                        birthday: contact.birthday,
                        notes: contact.notes,
                        categories,
                        eigenId: contact.eigenId || undefined,
                        photo: staged?.embed,
                    },
                    id,
                ),
            );

            await this.enforceCardBudget(bytes, 0);

            // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
            // drain and rethrows, and the durable intent recorded first covers a process death.
            try {
                this.recordCardWrite(uri);
                const { mtime, size } = await writeCardFile(this.storage, uri, bytes);
                // Promote the staged first-generation webp under the embed-derived cache name; the projection
                // stores its hashed URL (or '' if there is no photo).
                contact.avatar = staged ? await this.promoteAvatarCache(id, staged) : '';
                this.commitCard({
                    row: {
                        id,
                        uri,
                        uriKey: uriKeyOf(uri),
                        uid: id,
                        firstName: contact.firstName.trim(),
                        lastName: contact.lastName.trim(),
                        eigenId: this.resolveSelfLink(contact.eigenId),
                        isGroup: false,
                        data: toData(contact),
                        etag: computeCardEtag(bytes),
                        mtime: Math.round(mtime),
                        size,
                    },
                    categories,
                });
                this.cardsBytes += size;
            } catch (e) {
                this.markCardDirty(uri);
                throw e;
            }

            this.emitContact(SSEventType.CONTACT_CREATED, id);
            return id;
        });
    }

    public async updateContact(id: string, contact: CreateContactInput, expectedEtag?: string): Promise<void> {
        return this.writeLock.run(async () => {
            await this.drainDirty();
            // Runs before the self-card own-email prepend below, so that email can't be dropped as a blank.
            normalizeContactInput(contact);

            const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
            if (!row) throw new ApiError(404, 'Contact not found');
            if (expectedEtag !== undefined && expectedEtag !== row.etag) {
                throw new ApiError(412, 'Contact was changed elsewhere');
            }

            // A self-card edit also renames the user org-wide, but that push must not fire until the card has
            // actually saved — capture its inputs here (the avatar bytes from the incoming staged URL, before
            // the write replaces it with the cache URL) and push only after the commit succeeds. The own-email
            // prepend stays here: it must happen before the merge builds edits.
            const isSelf = row.eigenId === this.home.user.id;
            const selfName = `${contact.firstName} ${contact.lastName}`;
            let selfAvatarBuffer: Buffer | null = null;
            if (isSelf) {
                if (contact.avatar) {
                    const data = await this.downloadAvatar(contact.avatar.split('/').pop()!);
                    if (data) selfAvatarBuffer = Buffer.from(data);
                }
                if (!contact.email.includes(this.home.user.email)) {
                    contact.email = [this.home.user.email, ...contact.email];
                }
            }

            const card = parseVCard(new TextDecoder().decode(await this.readCardBytes(row.uri)));
            const categories = this.labelNamesFor(contact.labels ?? []);
            // REST is a full replacement, so every owned key is present; the merge is value-keyed, so
            // unchanged values keep their exact bytes. eigenId is omitted — the file's X-EIGEN-ID isn't
            // REST-owned (the reconcile rematch manages it).
            const edits: CardEdits = {
                firstName: contact.firstName.trim(),
                lastName: contact.lastName.trim(),
                email: contact.email,
                phone: contact.phone,
                address: contact.address ?? [],
                company: contact.company ?? '',
                jobTitle: contact.jobTitle ?? '',
                birthday: contact.birthday ?? '',
                notes: contact.notes ?? '',
                categories,
            };
            // PHOTO is presence-triggered: only touch it when the avatar changed against the stored row. A new
            // avatar embeds the staged Apple-safe bytes verbatim (or throws if its staged file was swept — a
            // silent strip would lose a photo the user meant to replace); an explicit clear (avatar === '')
            // removes PHOTO. The cache + projection URL are set from the promoted webp sibling after the write.
            const avatarChanged = contact.avatar !== (row.data?.avatar ?? '');
            let staged: StagedAvatarPair | null = null;
            if (avatarChanged) {
                if (contact.avatar) {
                    staged = await this.resolveStagedAvatar(contact.avatar);
                }
                edits.photo = staged?.embed ?? null;
            }

            const bytes = new TextEncoder().encode(mergeVCard(card, edits));

            // The stored card's bytes are credited: a rewrite that shrinks a card is never refused on quota.
            await this.enforceCardBudget(bytes, row.size);

            // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
            // drain and rethrows, and the durable intent recorded first covers a process death.
            try {
                this.recordCardWrite(row.uri);
                const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
                if (avatarChanged) {
                    contact.avatar = staged ? await this.promoteAvatarCache(id, staged) : '';
                }
                this.commitCard({
                    row: {
                        id,
                        uri: row.uri,
                        uriKey: row.uriKey,
                        uid: row.uid,
                        firstName: contact.firstName.trim(),
                        lastName: contact.lastName.trim(),
                        eigenId: row.eigenId,
                        isGroup: row.isGroup,
                        data: toData(contact),
                        etag: computeCardEtag(bytes),
                        mtime: Math.round(mtime),
                        size,
                    },
                    categories,
                });
                this.cardsBytes += size - row.size;
            } catch (e) {
                this.markCardDirty(row.uri);
                throw e;
            }

            // The card saved — now it is safe to rename the user's org-wide profile (a failed write never did).
            // Propagation is downstream of a settled mutation and may not rewrite its outcome: reporting a
            // failure here would hand the client back the etag it started with while the card already carries
            // a new one, so its retry 412s on an edit that succeeded.
            if (isSelf) {
                try {
                    await pushUserProfile(this.home.user.id, selfName, selfAvatarBuffer);
                } catch (e) {
                    console.error(`contacts: failed to propagate the profile of ${this.home.user.id}:`, e);
                }
            }
            this.emitContact(SSEventType.CONTACT_UPDATED, id);
        });
    }

    // The delete tail shared by REST deleteContact and DAV deleteCard: unlink the file (tolerating a vanished
    // one), tombstone the uri under one ctag bump (failing closed to a dirty re-index if the transaction
    // throws), decrement the running byte total, sweep the card's own derived avatar, and broadcast the
    // removal. Callers hold the writeLock and have already run their own guards (self-delete, preconditions).
    // internal — used by contacts/*.ts
    async purgeCard(row: typeof schema.contacts.$inferSelect): Promise<void> {
        try {
            await this.storage.unlink(cardPath(row.uri));
        } catch (e) {
            if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
        }
        // Fail closed if the index step throws after the file is already gone: mark the uri so the next
        // drain's vanished-file branch tombstones it, mirroring the create/update seams.
        try {
            this.db.transaction((tx) => {
                const ctag = this.bumpCtag(tx);
                tx.delete(schema.contacts).where(eq(schema.contacts.id, row.id)).run();
                this.tombstone(tx, row.uri, row.uriKey, ctag);
            });
        } catch (e) {
            this.markCardDirty(row.uri);
            throw e;
        }

        this.cardsBytes -= row.size;
        const avatarName = row.data?.avatar?.split('/').pop();
        if (avatarName && isCardPhotoCacheOf(row.id, avatarName)) {
            const avatarPath = `${PATHS.CONTACTS.AVATARS}/${avatarName}`;
            try {
                const avatarSize = await this.storage.size(avatarPath);
                if (avatarSize !== null) {
                    await this.storage.unlink(avatarPath);
                    this.avatarsBytes -= avatarSize;
                }
            } catch (e) {
                // The card and index deletion are already committed; a derived-cache failure is cleanup-only.
                console.error(`contacts: failed to delete derived avatar ${avatarName}:`, e);
            }
        }
        this.emitContact(SSEventType.CONTACT_DELETED, row.id);
    }

    public async deleteContact(id: string, expectedEtag?: string): Promise<void> {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
            // Idempotent: a REST DELETE of an already-gone resource is a no-op, and the etag is not evaluated
            // for a resource that no longer exists.
            if (!row) return;
            if (row.eigenId === this.home.user.id) {
                throw new ApiError(400, 'You cannot delete yourself');
            }
            if (expectedEtag !== undefined && expectedEtag !== row.etag) {
                throw new ApiError(412, 'Contact was changed elsewhere');
            }

            await this.purgeCard(row);
        });
    }

    // ---- Label facade — implementation in contacts/labels.ts ----

    public async getLabels(): Promise<Label[]> {
        return labels.getLabels(this);
    }

    private async resumeLabelRenames(): Promise<void> {
        return labels.resumeLabelRenames(this);
    }

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
        return labels.addLabel(this, label);
    }

    public async updateLabel(id: string, label: Omit<Label, 'id'>): Promise<Label> {
        return labels.updateLabel(this, id, label);
    }

    public async deleteLabel(id: string): Promise<void> {
        return labels.deleteLabel(this, id);
    }

    private dbRowToContact(row: typeof schema.contacts.$inferSelect, labelIds: string[]): Contact {
        const data = row.data ?? EMPTY_CARD_DATA;

        return {
            id: row.id,
            firstName: row.firstName.trim(),
            lastName: row.lastName.trim(),
            eigenId: row.eigenId,
            etag: row.etag,
            ...data,
            labels: labelIds,
        };
    }

    public async getContactById(id: string): Promise<Contact | null> {
        await this.ensureDrained();
        const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
        if (!row || row.isGroup) return null;
        const labelIds = this.db
            .select({ labelId: schema.contactsToLabels.labelId })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.contactId, row.id))
            .all()
            .map((rel) => rel.labelId);
        return this.dbRowToContact(row, labelIds);
    }

    public async getContacts(): Promise<Contact[]> {
        await this.ensureDrained();
        // Groups are DAV-only aggregates; the app's contact list never shows them.
        const rows = this.db.select().from(schema.contacts).where(eq(schema.contacts.isGroup, false)).all();

        // Load every contact→label link in one scan of the (contactId, labelId) PK, grouped by
        // contact — a single query instead of the per-row SELECT this used to run (1+N).
        const labelsByContact = new Map<string, string[]>();
        const relations = this.db
            .select({ contactId: schema.contactsToLabels.contactId, labelId: schema.contactsToLabels.labelId })
            .from(schema.contactsToLabels)
            .all();
        for (const rel of relations) {
            const list = labelsByContact.get(rel.contactId);
            if (list) list.push(rel.labelId);
            else labelsByContact.set(rel.contactId, [rel.labelId]);
        }

        return rows.map((row) => this.dbRowToContact(row, labelsByContact.get(row.id) ?? []));
    }

    // ---- Avatar facade — implementation in contacts/avatars.ts ----

    public async uploadAvatar(file: File): Promise<string> {
        return avatars.uploadAvatar(this, file);
    }

    public async downloadAvatar(filename: string): Promise<ArrayBuffer | null> {
        return avatars.downloadAvatar(this, filename);
    }

    private async resolveStagedAvatar(stagedUrl: string | undefined): Promise<StagedAvatarPair | null> {
        return avatars.resolveStagedAvatar(this, stagedUrl);
    }

    private async promoteAvatarCache(contactId: string, staged: StagedAvatarPair): Promise<string> {
        return avatars.promoteAvatarCache(this, contactId, staged);
    }

    private async deriveCardPhotoCache(id: string, photo: ParsedCardPhoto | null): Promise<string> {
        return avatars.deriveCardPhotoCache(this, id, photo);
    }

    // Public only as a test seam (contacts-photos.test.ts); the facade reaches it through deriveCardPhotoCache.
    public async cacheCardPhoto(contactId: string, photo: ParsedCardPhoto | null): Promise<string> {
        return avatars.cacheCardPhoto(this, contactId, photo);
    }

    private cleanupAvatarImages(): Promise<void> {
        return avatars.cleanupAvatarImages(this);
    }

    private selfRow() {
        return this.db.select().from(schema.contacts).where(eq(schema.contacts.eigenId, this.home.user.id)).get();
    }

    private hasContactWithEmail(email: string): boolean {
        const target = email.toLowerCase();
        return this.db
            .select({ data: schema.contacts.data })
            .from(schema.contacts)
            .all()
            .some((row) => (row.data?.email ?? []).some((e) => e.toLowerCase() === target));
    }

    private async addYourself(): Promise<string> {
        const user = this.home.user;
        const [firstName, ...rest] = (user.name || '').split(' ');
        return await this.addContact({
            eigenId: user.id,
            firstName: firstName || '',
            lastName: rest.join(' '),
            email: [user.email],
            phone: [],
            company: '',
            jobTitle: '',
            address: [],
            birthday: '',
            notes: '',
            avatar: '',
            labels: [],
        });
    }

    public async getMe(): Promise<Contact | null> {
        await this.ensureDrained();
        const found = this.selfRow();
        if (found) {
            return this.getContactById(found.id);
        }
        const addedId = await this.addYourself();
        return this.getContactById(addedId);
    }

    // ---- CardDAV store facade — implementation in contacts/dav-store.ts ----

    public async getBook(): Promise<CardBook> {
        return davStore.getBook(this);
    }

    public async listCards(): Promise<CardRow[]> {
        return davStore.listCards(this);
    }

    public async getChangedCardsSince(sinceCtag: number): Promise<CardRow[]> {
        return davStore.getChangedCardsSince(this, sinceCtag);
    }

    public async getDeletedCardsSince(sinceCtag: number): Promise<{ uri: string }[]> {
        return davStore.getDeletedCardsSince(this, sinceCtag);
    }

    public async getCard(uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
        return davStore.getCard(this, uri);
    }

    public async getCardMeta(uri: string): Promise<CardRow | null> {
        return davStore.getCardMeta(this, uri);
    }

    public async putCard(
        uri: string,
        body: string,
        pre: { ifMatch: string | null; ifNoneMatch: string | null },
    ): Promise<PutCardResult> {
        return davStore.putCard(this, uri, body, pre);
    }

    public async deleteCard(uri: string, pre: { ifMatch: string | null }): Promise<DeleteCardResult> {
        return davStore.deleteCard(this, uri, pre);
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
