import { randomUUID } from 'node:crypto';
import type { Address, Contact, CreateContactInput } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, gt, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import type { ParsedCard, ParsedCardPhoto } from '../carddav/vcard-parse';
import { normalizeBirthday, parseVCard } from '../carddav/vcard-parse';
import { type CardEdits, createVCard, mergeVCard } from '../carddav/vcard-serialize';
import { transcodeTo30 } from '../carddav/vcard-transcode';
import { enforceContactsIngest } from '../config/enforcement';
import { getServerSettings } from '../config/server-settings';
import type { ManagedDatabase } from '../core';
import { ApiError, DEFAULT_LABELS, LocalFilesystem, PATHS } from '../core';
import type { Home } from '../home';
import { atHome, getHome } from '../home';
import { pushUserProfile } from '../home/home-relay';
import { generateImagePreview } from '../shared/thumbnails';
import type { User } from '../user';
import { getOrgOwner } from '../user/';
import {
    AVATAR_FILENAME,
    avatarCacheName,
    avatarUrl,
    CARD_MAX_BYTES,
    CARDS_DIR,
    cardPath,
    cleanupTempCardFiles,
    computeCardEtag,
    type EmbedFormat,
    isCardPhotoCacheOf,
    labelColorFor,
    listCardUris,
    normalizeLabelName,
    sanitizeCardUri,
    stagedEmbedCandidates,
    stagedEmbedName,
    uriKeyOf,
    writeCardFile,
} from './card-store';
import { CONTACTS_DB_CONFIG } from './db-config';
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
type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;

// The only incumbent-row scalars the candidate build reads: a stable contact id, the uid fallback, and the
// eigenId that ranks a self-link claim. The reconcile/rebuild passes project these (never the `data` JSON) so
// init never parses a stored projection.
type IndexIncumbent = Pick<typeof schema.contacts.$inferSelect, 'id' | 'uid' | 'eigenId'>;

// One card file, read and prepared but not yet committed — what phase 1 of the reconcile/rebuild passes
// produces and phases 2/3 (self-link ranking, uid dedupe, the write transaction) consume. The incumbent
// rides along so the caller can tell a new card from an updated one.
type CardCandidate = {
    row: CardRowInput;
    categories: string[];
    parsed: ParsedCard;
    existing?: IndexIncumbent;
    rank: 0 | 1 | 2 | 3;
};

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

// A freshly-staged avatar has no card referencing it yet — the user is still filling in the form. Give an
// upload an hour before the unreferenced-avatar sweep may reclaim it, so an in-progress edit's staged webp
// isn't deleted out from under the save.
const AVATAR_STAGE_GRACE_MS = 60 * 60 * 1000;

// Every contact-photo encode shares one preview shape: a 512px q80 square-cropped image. It defaults to webp
// (the only format Eigen serves); the staged embed sibling spreads it with format:'jpeg'/'png'/'gif' for the
// Apple-safe PHOTO bytes. App-authored cards with this shape naturally stay around 230 KiB; that is normal
// behavior, not a resource limit or guarantee.
const AVATAR_PREVIEW = { maxSize: 512, quality: 80, fit: 'cover' } as const;

// A single animated GIF embedded in a card rides along in every device sync of that card. Past this ceiling the
// staged embed falls back to a first-frame JPEG so one long GIF can't bloat every sync (the served webp sibling
// stays animated regardless — the cap is only on the bytes stored in the vCard).
const AVATAR_EMBED_GIF_MAX_BYTES = 2 * 1024 * 1024;

// The two first-generation encodes a staged upload carries: the Apple-safe embed the save writes verbatim into
// PHOTO, and the webp sibling it promotes to the cache. `resolveStagedAvatar` pairs them from a staged url.
type StagedAvatarPair = { embed: { bytes: Uint8Array; mediaType: string }; webp: Uint8Array };

// The v2 UNIQUE index on labels(nameKey) closes duplicate/case-variant label names. bun:sqlite names the
// column in the violation message ("UNIQUE constraint failed: labels.nameKey"); match on it so an unrelated
// UNIQUE (the id PRIMARY KEY) still surfaces as a real error rather than a spurious 409.
function rethrowDuplicateLabelName(e: unknown): never {
    if (e instanceof Error && e.message.includes('labels.nameKey')) {
        throw new ApiError(409, 'A label with this name already exists');
    }
    throw e;
}

// The index projection the CardDAV sync layer reads for a resource (multiget/sync-collection). Group cards
// are included — DAV sees the whole book — and the etag is the unquoted content hash the handler quotes.
export type CardRow = { uri: string; etag: string; isGroup: boolean };

// The book counters every DAV sync surface reads: ctag advances on each change, syncGen rotates on an index
// rebuild so stale sync tokens are refused. Named once, as CalDAV's builders take a CalendarItem.
export type CardBook = { ctag: number; syncGen: number };

// The typed outcome of a DAV PUT: a mapped precondition/conflict/limit result the handler turns into a 4xx,
// or the stored etag plus whether the resource was newly created (201 vs 204). No raw throw crosses this seam
// for a client-caused failure — only genuine IO errors bubble.
export type PutCardResult =
    | { ok: true; etag: string; created: boolean }
    | { ok: false; error: 'precondition' | 'uid-conflict' | 'invalid' | 'too-large' | 'quota'; message?: string };

// RFC 7232 precondition matching for the DAV write seam. `*` means "the resource exists" (not a literal
// etag); a value is a comma-separated list of entity-tags, each optionally weak (`W/`) and quoted — it
// matches when any member equals the current (unquoted) etag. Stored etags are bare content hashes, so a
// header entry is compared after stripping its weak prefix and surrounding quotes. Used by both putCard
// (If-Match / If-None-Match) and deleteCard (If-Match).
function preconditionMatches(header: string, etag: string | null): boolean {
    if (header === '*') return etag !== null;
    if (etag === null) return false;
    return header.split(',').some((raw) => raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === etag);
}

export class Contacts {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;
    private storage: LocalFilesystem;

    // All card mutations (REST and, later, DAV) serialize through one slot so a file write and its index
    // commit stay a pair and etag preconditions are evaluated against the state they'll overwrite (spec § 3).
    private writeLock = new Semaphore(1);

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
    private cardsBytes = 0;
    private avatarsBytes = 0;

    // Whether card writes are quota-metered — see the assignment in init() for what turns it on.
    private meteredIngest = false;

    constructor(home: Home) {
        this.home = home;
        this.storage = new LocalFilesystem(`${home.homeDir}/${PATHS.CONTACTS.ROOT}`);
    }

    private emitContact(type: Parameters<typeof buildContactEvent>[0], contactId: string): void {
        this.home.broadcast(buildContactEvent(type, contactId));
    }

    private emitLabel(type: Parameters<typeof buildLabelEvent>[0], labelId: string): void {
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
    private bumpCtag(tx: Tx): number {
        tx.update(schema.book)
            .set({ ctag: sql`${schema.book.ctag} + 1` })
            .where(eq(schema.book.id, 1))
            .run();
        return tx.select({ ctag: schema.book.ctag }).from(schema.book).where(eq(schema.book.id, 1)).get()!.ctag;
    }

    // Upsert a removal tombstone keyed by uri (carrying the folded uriKey so a re-created case-variant card
    // clears it), stamped with the current ctag. One shape shared by drainDirty, reconcile and deleteContact.
    private tombstone(tx: Tx, uri: string, uriKey: string, ctag: number): void {
        tx.insert(schema.contactTombstones)
            .values({ uri, uriKey, deletedAtCtag: ctag })
            .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
            .run();
    }

    private readCardBytes(uri: string): Promise<Uint8Array> {
        return this.storage.file(cardPath(uri)).bytes();
    }

    // Rebuild a card's label junction from its CATEGORIES inside `tx`: each name resolves to a label by
    // nameKey, minting one with its deterministic color when absent (new ids collected so the caller can
    // emit LABEL_CREATED after the transaction). Shared by commitCard and the reconcile/rebuild passes.
    private syncCardLabels(tx: Tx, contactId: string, categories: string[], createdLabelIds: string[]): void {
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
    private commitCard(opts: { row: CardRowInput; categories: string[]; tombstoneCleared?: boolean }): void {
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
    // inside the caller's writeLock; the directory-wide reconcile it becomes part of is Task 11.
    private async drainDirty(): Promise<void> {
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

    private markCardDirty(uri: string): void {
        this.dirtyCards.add(uri);
    }

    // Durable write intent, recorded before a card file is written: while it exists, the index owes that uri
    // a commit. commitCard clears it inside the transaction that pays the debt.
    private recordCardWrite(uri: string): void {
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
    private async ensureDrained(): Promise<void> {
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
    // inline-photo cache (Task 10 seam). The self-link is left `''` here and assigned to the single ranked
    // winner afterwards (see `selfClaimRank`/`applySelfLink`) so no loser is ever written or indexed as self.
    // `id` is the stable contact id (an existing row's or a fresh one), `existingUid` the uid fallback.
    private async prepareCardRow(
        uri: string,
        id: string,
        existingUid: string | undefined,
    ): Promise<{ row: CardRowInput; categories: string[]; parsed: ParsedCard }> {
        const bytes = new Uint8Array(await this.storage.file(cardPath(uri)).arrayBuffer());
        const parsed = this.parseCardFile(bytes);

        // The projection avatar is the derived cache URL; regenerate it only when the file has an inline photo
        // whose hashed cache file is missing (out-of-band drift / a rebuild after a cache wipe).
        let avatar = '';
        if (parsed.photo?.kind === 'inline') {
            const cacheName = avatarCacheName(id, parsed.photo.bytes);
            avatar = avatarUrl(this.home.user.id, cacheName);
            if (!(await this.storage.exists(`${PATHS.CONTACTS.AVATARS}/${cacheName}`))) {
                avatar = await this.cacheCardPhoto(id, parsed.photo);
            }
        }

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

    // Strength of a card's claim to the single self-link slot (spec § 2), highest wins; ties break by uri sort
    // (candidates are pre-sorted). 3 incumbent — the card's existing index row already held the link; 2 strong —
    // the file asserts X-EIGEN-ID = user.id; 1 email-only — no X-EIGEN-ID but an exact owner-email match (a weak
    // claim that only rewrites the file if it actually wins). A forged foreign X-EIGEN-ID scores 0 — it stays in
    // the file verbatim and drives nothing.
    private selfClaimRank(parsed: ParsedCard, incumbentEigenId: string | undefined): 0 | 1 | 2 | 3 {
        if (incumbentEigenId === this.home.user.id) return 3;
        if (parsed.eigenId === this.home.user.id) return 2;
        const ownerEmail = this.home.user.email.toLowerCase();
        if (!parsed.eigenId && parsed.email.some((e) => e.toLowerCase() === ownerEmail)) return 1;
        return 0;
    }

    // Pick the highest-ranked self-link claimant (first in the pre-sorted list on a tie); a strictly-greater rank
    // is required to displace, so the earliest max-rank card wins.
    private pickSelfWinner(candidates: CardCandidate[]): CardCandidate | undefined {
        let winner: CardCandidate | undefined;
        for (const c of candidates) {
            if (c.rank > 0 && (!winner || c.rank > winner.rank)) winner = c;
        }
        return winner;
    }

    // Stamp the chosen winner's row with the self-link and, when its file does not already assert the link,
    // restore X-EIGEN-ID into that one file and re-stat/re-etag it — the § 2 durability rewrite, covering an
    // email-only claim and an incumbent whose file a client stripped. No loser's file is ever touched.
    private async applySelfLink(winner: CardCandidate): Promise<void> {
        winner.row.eigenId = this.home.user.id;
        if (winner.parsed.eigenId === this.home.user.id) return;
        const bytes = new TextEncoder().encode(mergeVCard(winner.parsed, { eigenId: this.home.user.id }));
        await writeCardFile(this.storage, winner.row.uri, bytes);
        const stat = await this.storage.stat(cardPath(winner.row.uri));
        winner.row.etag = computeCardEtag(bytes);
        winner.row.mtime = Math.round(stat.mtimeMs);
        winner.row.size = stat.size;
    }

    // Drop prepared rows whose uid is already owned by a row the transaction will leave in place — the
    // idx_contacts_uid UNIQUE would otherwise throw inside the write and brick the whole pass (spec § 1).
    // `uidOwner` maps each uid to the row id that will hold it after the pass: seeded with every surviving
    // row (reconcile) or empty (rebuild clears the table first). A candidate updating its own incumbent keeps
    // that row's slot (owner === its id); any other collision is skipped-and-warned, earliest uri winning
    // since candidates arrive uri-sorted.
    private dedupeByUid(candidates: CardCandidate[], uidOwner: Map<string, string>): CardCandidate[] {
        const kept: CardCandidate[] = [];
        for (const c of candidates) {
            const owner = uidOwner.get(c.row.uid);
            if (owner !== undefined && owner !== c.row.id) {
                console.warn(`contacts: skipping ${c.row.uri} — UID ${c.row.uid} already claimed by another card`);
                continue;
            }
            uidOwner.set(c.row.uid, c.row.id);
            kept.push(c);
        }
        return kept;
    }

    // Phase 1 of both passes: parse + prepare each entry into a candidate row without touching the self-link,
    // ranking its self-claim against the entry's incumbent eigenId. A card that can't be read (garbage vCard,
    // or one that vanished mid-pass) is skipped-and-logged rather than failing the whole pass (spec § 1).
    private async buildCandidates(entries: { uri: string; existing?: IndexIncumbent }[]): Promise<CardCandidate[]> {
        const candidates: CardCandidate[] = [];
        for (const { uri, existing } of entries) {
            try {
                const p = await this.prepareCardRow(uri, existing?.id ?? randomUUID(), existing?.uid);
                candidates.push({ ...p, existing, rank: this.selfClaimRank(p.parsed, existing?.eigenId) });
            } catch (e) {
                console.warn(`contacts: skipping unreadable card ${uri}: ${e}`);
            }
        }
        return candidates;
    }

    // Stat-only reconcile: list cards/, compare (mtime,size) to the index, and re-read only what drifted (plus
    // any row whose derived avatar cache is gone) — the clean case (always, in practice) is two listings plus
    // stats, zero file reads. New/drifted cards are re-indexed and vanished rows tombstoned under a single ctag
    // bump; a fully clean pass parses nothing and bumps nothing (spec § 1). A same-size, timestamp-preserving
    // replacement is invisible here — that needs `rebuildIndex`.
    public async reconcileIndex(): Promise<void> {
        return this.writeLock.run(async () => {
            const present = new Map<string, { uri: string; mtime: number; size: number }>();
            // A stat that failed (transient IO, not a real removal) must not tombstone a live row, so track its
            // key and exclude it from the vanished set below.
            const skipped = new Set<string>();
            // listCardUris hands back the sanitized, sorted, case-deduped uris; stat each to capture drift.
            for (const { uri, key } of await listCardUris(this.storage)) {
                try {
                    const stat = await this.storage.stat(cardPath(uri));
                    present.set(key, { uri, mtime: Math.round(stat.mtimeMs), size: stat.size });
                } catch (e) {
                    // Listed but un-stattable — skip it this pass; the next one catches up. Its row is NOT
                    // treated as vanished, so a transient failure can't delete + tombstone a live card.
                    skipped.add(key);
                    console.warn(`contacts: skipping ${uri} — could not stat card file: ${e}`);
                }
            }

            // Project the scalars the pass reads plus the stored projection's avatar URL — no card file is
            // read, so a clean init still parses nothing.
            const rows = this.db
                .select({
                    id: schema.contacts.id,
                    uri: schema.contacts.uri,
                    uriKey: schema.contacts.uriKey,
                    uid: schema.contacts.uid,
                    mtime: schema.contacts.mtime,
                    size: schema.contacts.size,
                    eigenId: schema.contacts.eigenId,
                    data: schema.contacts.data,
                })
                .from(schema.contacts)
                .all();
            const rowByKey = new Map(rows.map((r) => [r.uriKey, r] as const));

            // One listing answers "is this row's derived avatar cache still there?" for every row. Without it,
            // restoring cards/ + contacts.db without avatars/ leaves stat-clean cards whose avatar URL 404s
            // forever — no card ever drifts on its own, so nothing would ever regenerate the cache.
            const avatarFiles = new Set(await this.storage.list(PATHS.CONTACTS.AVATARS));

            const reindex: { uri: string; existing?: (typeof rows)[number] }[] = [];
            for (const [key, info] of present) {
                const existing = rowByKey.get(key);
                const avatarName = existing?.data?.avatar?.split('/').pop();
                const cacheMissing = !!avatarName && !avatarFiles.has(avatarName);
                if (!existing || info.mtime !== existing.mtime || info.size !== existing.size || cacheMissing) {
                    reindex.push({ uri: info.uri, existing });
                }
            }
            const vanished = rows.filter((r) => !present.has(r.uriKey) && !skipped.has(r.uriKey));

            // What cards/ holds right now — cardsBytes whenever this pass commits nothing. Unindexable bytes
            // count: the file occupies storage (and quota) whether or not the index can make sense of it, and
            // rebuildIndex counts the same way.
            const presentBytes = [...present.values()].reduce((sum, p) => sum + p.size, 0);

            if (reindex.length === 0 && vanished.length === 0) {
                this.cardsBytes = presentBytes;
                return; // clean pass: zero parses, zero bump
            }

            reindex.sort((a, b) => (a.uri < b.uri ? -1 : 1)); // stable order for the self-link tie-break
            const reindexKeys = new Set(reindex.map((r) => uriKeyOf(r.uri)));

            const candidates = await this.buildCandidates(reindex);

            // Seed the uid→owner guard with every row that will REMAIN after the vanished deletes (not just the
            // untouched ones): a reindexing incumbent whose candidate is skipped-as-garbage or loses dedupe keeps
            // its stored uid, so a new same-UID card must lose to it rather than trip the UNIQUE index inside the
            // transaction. A candidate updating its own incumbent (owner === its id) is free to keep that uid.
            const vanishedIds = new Set(vanished.map((r) => r.id));
            const uidOwner = new Map(rows.filter((r) => !vanishedIds.has(r.id)).map((r) => [r.uid, r.id] as const));
            const prepared = this.dedupeByUid(candidates, uidOwner);

            // Nothing survived to commit — every drifted card was skipped as unreadable or dropped by the uid
            // guard — and nothing vanished. A card that can never be indexed drifts into this set on every
            // restart, so running the transaction here would bump the ctag for a book that never changed and
            // send every client into a no-op delta poll per restart (spec § 1).
            if (prepared.length === 0 && vanished.length === 0) {
                this.cardsBytes = presentBytes;
                return;
            }

            // Phase 2: choose the one self-link winner. A self row that survives this pass untouched (file
            // present or un-stattable, and not re-indexing) holds the slot outright; only a self row whose file
            // is really gone — tombstoned this same pass — frees the slot for a twin's claim. A skipped stat is
            // explicitly not a removal above, so it may not silently mint a second eigenId row here either.
            const survivingSelf = rows.some(
                (r) =>
                    r.eigenId === this.home.user.id &&
                    !reindexKeys.has(r.uriKey) &&
                    (present.has(r.uriKey) || skipped.has(r.uriKey)),
            );
            if (!survivingSelf) {
                const winner = this.pickSelfWinner(prepared);
                if (winner) await this.applySelfLink(winner);
            }

            const createdLabelIds: string[] = [];
            this.db.transaction((tx) => {
                const ctag = this.bumpCtag(tx);
                // Delete vanished rows before inserting prepared ones so a card renamed within this pass (old
                // uri gone, new uri carrying the same UID) can't collide with the row it replaces on the uid
                // UNIQUE index.
                for (const r of vanished) {
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, r.id)).run();
                    this.tombstone(tx, r.uri, r.uriKey, ctag);
                }
                for (const { row } of prepared) {
                    tx.insert(schema.contacts)
                        .values({ ...row, cardCtag: ctag })
                        .onConflictDoUpdate({
                            target: schema.contacts.id,
                            set: {
                                // uri/uriKey/uid follow the file: a delete + case-variant recreate reuses the
                                // contact id but changes the on-disk name, so the stored uri must refresh or
                                // every later read ENOENTs on a case-sensitive FS.
                                uri: row.uri,
                                uriKey: row.uriKey,
                                uid: row.uid,
                                firstName: row.firstName,
                                lastName: row.lastName,
                                eigenId: row.eigenId,
                                isGroup: row.isGroup,
                                data: row.data,
                                etag: row.etag,
                                cardCtag: ctag,
                                mtime: row.mtime,
                                size: row.size,
                                updatedAt: sql`unixepoch()`,
                            },
                        })
                        .run();
                    // A present card is alive again: clear any live tombstone for its uri (by the folded key, as
                    // commitCard does) so a card re-planted at a deleted uri drops its stale removal.
                    tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uriKey, row.uriKey)).run();
                    // This pass just paid whatever write intent the uri carried — a crashed write whose file
                    // drifted. Clearing it here (as commitCard does for its own) keeps the recovery drain that
                    // follows init's reconcile from re-parsing and re-bumping the very card it re-indexed.
                    tx.delete(schema.pendingCardWrites).where(eq(schema.pendingCardWrites.uri, row.uri)).run();
                }
                for (const { row, categories } of prepared)
                    this.syncCardLabels(tx, row.id, categories, createdLabelIds);
            });

            // cardsBytes is authoritative from the pass's final sizes (post-rewrite for any rematched card; a
            // skipped card keeps its present size — its file is still on disk).
            const finalSize = new Map<string, number>();
            for (const [key, info] of present) finalSize.set(key, info.size);
            for (const { row } of prepared) finalSize.set(row.uriKey, row.size);
            this.cardsBytes = [...finalSize.values()].reduce((sum, v) => sum + v, 0);

            for (const labelId of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, labelId);
            for (const { row, existing } of prepared) {
                this.emitContact(existing ? SSEventType.CONTACT_UPDATED : SSEventType.CONTACT_CREATED, row.id);
            }
            for (const r of vanished) this.emitContact(SSEventType.CONTACT_DELETED, r.id);
        });
    }

    // From-scratch rebuild: re-read every card, rebuild the index (stable contact ids preserved by uri), clear
    // tombstones, and rotate book.syncGen so old sync tokens die and clients full-resync (RFC 6578 recovery,
    // spec § 1). Runs when init's integrity check fails; also exported for a future admin path (no route in v1).
    // Catches the same-stat replacement a stat-only reconcile cannot.
    public async rebuildIndex(): Promise<void> {
        return this.writeLock.run(async () => {
            // Only the scalars a rebuild reads from an incumbent — id/uid preserve identity, eigenId ranks the
            // self-link claim; the `data` JSON is re-derived from the file, never read here.
            const existingByKey = new Map(
                this.db
                    .select({
                        id: schema.contacts.id,
                        uriKey: schema.contacts.uriKey,
                        uid: schema.contacts.uid,
                        eigenId: schema.contacts.eigenId,
                    })
                    .from(schema.contacts)
                    .all()
                    .map((r) => [r.uriKey, r] as const),
            );
            // `.get()` yields undefined for a missing book row, so one read covers both the intact and gone cases.
            const book = this.db.select().from(schema.book).where(eq(schema.book.id, 1)).get();
            const newCtag = Math.max(book?.ctag ?? 0, 0) + 1;
            const newSyncGen = (book?.syncGen ?? 1) + 1;

            // listCardUris hands back the sanitized, sorted, case-deduped uris (already the stable self-link
            // tie-break order); pair each with its pre-clear incumbent so a surviving self row still outranks an
            // email-only twin that sorts earlier.
            const entries = (await listCardUris(this.storage)).map(({ uri, key }) => ({
                uri,
                key,
                existing: existingByKey.get(key),
            }));
            const candidates = await this.buildCandidates(entries);
            // The whole index is cleared and rebuilt below, so nothing survives to seed the collision guard —
            // two files sharing a UID resolve purely first-by-uri.
            const prepared = this.dedupeByUid(candidates, new Map());

            // Phase 2: the highest-ranked card claims the single self-link; only an email-only winner is rewritten.
            const winner = this.pickSelfWinner(prepared);
            if (winner) await this.applySelfLink(winner);

            const createdLabelIds: string[] = [];
            this.db.transaction((tx) => {
                tx.delete(schema.contactsToLabels).run();
                tx.delete(schema.contacts).run();
                tx.delete(schema.contactTombstones).run();
                tx.insert(schema.book)
                    .values({ id: 1, ctag: newCtag, syncGen: newSyncGen })
                    .onConflictDoUpdate({ target: schema.book.id, set: { ctag: newCtag, syncGen: newSyncGen } })
                    .run();
                for (const { row } of prepared)
                    tx.insert(schema.contacts)
                        .values({ ...row, cardCtag: newCtag })
                        .run();
                for (const { row, categories } of prepared)
                    this.syncCardLabels(tx, row.id, categories, createdLabelIds);
            });

            // cardsBytes answers what cards/ holds, not what the index understood — the same rule the reconcile
            // pass follows, so the two passes never disagree about the book's size. A card skipped as unreadable
            // or dropped by the uid guard still occupies storage, so its bytes are still counted.
            const indexedKeys = new Set(prepared.map((p) => p.row.uriKey));
            let bytes = prepared.reduce((sum, p) => sum + p.row.size, 0);
            for (const { uri, key } of entries) {
                if (!indexedKeys.has(key)) bytes += (await this.storage.size(cardPath(uri))) ?? 0;
            }
            this.cardsBytes = bytes;

            for (const labelId of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, labelId);
        });
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

    // The single self-link for a card being PUT, plus the bytes to store (§ 2). commitCard's UPDATE omits
    // eigenId, so an incumbent's link rides an update untouched — this decides only what the row carries and
    // whether the file needs X-EIGEN-ID restored. On update the row keeps its existing link (a non-self card
    // stays non-self; promoting it is left to the reconcile rematch, as updateContact does). On create it
    // claims the link when its X-EIGEN-ID or an exact owner-email match wins and no other row already holds
    // it (selfClaimRank). When this card holds the link but its bytes don't assert X-EIGEN-ID — a client
    // stripped it, or an email-only claim never wrote it — the property is restored so the stored file and
    // the index never disagree (applySelfLink's shape, but before the single write a PUT makes). Sync: no IO.
    private resolveSelfLinkOnPut(
        parsed: ParsedCard,
        bytes: Uint8Array,
        existing: { id: string; eigenId: string } | undefined,
    ): { eigenId: string; bytes: Uint8Array } {
        const me = this.home.user.id;
        let eigenId: string;
        if (existing) {
            eigenId = existing.eigenId;
        } else {
            const claim = this.selfClaimRank(parsed, undefined) >= 1;
            const heldElsewhere = !!this.db
                .select({ id: schema.contacts.id })
                .from(schema.contacts)
                .where(eq(schema.contacts.eigenId, me))
                .get();
            eigenId = claim && !heldElsewhere ? me : '';
        }
        if (eigenId === me && parsed.eigenId !== me) {
            return { eigenId, bytes: new TextEncoder().encode(mergeVCard(parsed, { eigenId: me })) };
        }
        return { eigenId, bytes };
    }

    // What a card must fit through before it is written: the 5 MiB resource ceiling (spec § 4 — it bounds
    // what a device sync and every later reconcile has to parse) and the mail+contacts quota, credited with
    // the bytes of the card this one replaces. Called inside the writeLock, after the index is drained (so
    // the size() behind the quota lookup can't re-enter the lock) and before any write intent is recorded —
    // a refusal leaves nothing on disk and nothing for a drain to chase.
    private async enforceCardBudget(bytes: Uint8Array, creditBytes: number): Promise<void> {
        if (bytes.byteLength > CARD_MAX_BYTES) {
            throw new ApiError(413, 'Contact card is too large');
        }
        if (this.meteredIngest) {
            await enforceContactsIngest(this.home.user.id, bytes.byteLength, creditBytes);
        }
    }

    private labelNamesFor(labelIds: string[]): string[] {
        if (labelIds.length === 0) return [];
        const byId = new Map(
            this.db
                .select({ id: schema.labels.id, name: schema.labels.name })
                .from(schema.labels)
                .all()
                .map((l) => [l.id, l.name] as const),
        );
        return labelIds.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
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
            // REST-owned here (rematch is Task 11).
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
    private async purgeCard(row: typeof schema.contacts.$inferSelect): Promise<void> {
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

    // Projected to the DTO: nameKey and the timestamps are index bookkeeping, not part of the wire contract.
    public async getLabels(): Promise<Label[]> {
        await this.ensureDrained();
        return this.db
            .select({ id: schema.labels.id, name: schema.labels.name, color: schema.labels.color })
            .from(schema.labels)
            .all();
    }

    // The contacts linked to any of these labels, deduped — the fan-out set for a rename or a delete.
    private labelMemberIds(labelIds: string[]): string[] {
        const rows = this.db
            .select({ contactId: schema.contactsToLabels.contactId })
            .from(schema.contactsToLabels)
            .where(inArray(schema.contactsToLabels.labelId, labelIds))
            .all();
        return [...new Set(rows.map((r) => r.contactId))];
    }

    // A label rename/delete fans out to its member cards so CATEGORIES stays the membership truth: each card
    // is re-read, its category names remapped by `transform`, then written and re-indexed through the same
    // file→commit pipeline as a contact edit (its etag/cardCtag bump, so DAV clients re-fetch). Callers hold
    // the writeLock and drive it directly rather than via updateContact, which would re-enter the
    // non-reentrant lock.
    private async rewriteCardCategories(contactIds: string[], transform: (names: string[]) => string[]): Promise<void> {
        for (const contactId of contactIds) {
            const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).get();
            if (!row) continue;

            // One member corrupted out of band may not take the fan-out down with it: a throw here strands the
            // rename's journal record, and every later label mutation resumes it and fails again — one bad file
            // would brick all label writes. Skip-and-log instead (as buildCandidates does), leaving that card's
            // CATEGORIES for the reconcile/rebuild that can read the file again to converge (spec § 1).
            let card: ParsedCard;
            try {
                card = parseVCard(new TextDecoder().decode(await this.readCardBytes(row.uri)));
            } catch (e) {
                console.warn(`contacts: skipping unreadable card ${row.uri} in the label fan-out: ${e}`);
                continue;
            }
            const categories = transform(card.categories);
            // A card the transform doesn't touch — one a resumed fan-out already reached, or whose CATEGORIES
            // never carried the name — keeps its exact bytes: no etag rotation, nothing for clients to refetch.
            const unchanged =
                categories.length === card.categories.length && categories.every((n, i) => n === card.categories[i]);
            if (unchanged) continue;

            const bytes = new TextEncoder().encode(mergeVCard(card, { categories }));

            try {
                this.recordCardWrite(row.uri);
                const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
                this.commitCard({
                    row: {
                        id: row.id,
                        uri: row.uri,
                        uriKey: row.uriKey,
                        uid: row.uid,
                        firstName: row.firstName,
                        lastName: row.lastName,
                        eigenId: row.eigenId,
                        isGroup: row.isGroup,
                        // Deliberately the stored projection, not the fresh parse: committing it with the
                        // rewritten file's stats hides an out-of-band edit from the stat-only reconcile. Only
                        // hand-editing a card file under a live server can produce that, so projecting from the
                        // parse above is deferred to the phase-2 DAV PUT seam.
                        data: row.data,
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

            this.emitContact(SSEventType.CONTACT_UPDATED, row.id);
        }
    }

    // Finish a label rename whose member-card fan-out never completed — process death mid-fan-out, or a
    // compensation that itself failed. The label row is the truth for the final name, so every member card
    // carrying either spelling is remapped onto it (a forward fan-out resumes, a half-compensated one rolls
    // back, a case-only rename still lands its casing). The transform is keyed on the name, so re-running it
    // rewrites nothing once the cards agree, and the record clears only after every member committed. Caller
    // holds the writeLock, as drainDirty's callers do.
    private async resumeLabelRenames(): Promise<void> {
        for (const pending of this.db.select().from(schema.pendingLabelRenames).all()) {
            // The record cascades with its label row, so the label is always there.
            const label = this.db.select().from(schema.labels).where(eq(schema.labels.id, pending.labelId)).get()!;
            const keys = [...new Set([normalizeLabelName(pending.oldName), normalizeLabelName(pending.newName)])];
            // A member the fan-out never reached re-mints the name it still carries as a label of its own the
            // moment membership is re-derived from CATEGORIES (the drain above, a rebuild). Those cards are
            // this rename's members too; their stand-in label rows go once the cards are back on the real one.
            const duplicateIds = this.db
                .select({ id: schema.labels.id })
                .from(schema.labels)
                .where(inArray(schema.labels.nameKey, keys))
                .all()
                .map((l) => l.id)
                .filter((id) => id !== pending.labelId);

            await this.rewriteCardCategories(this.labelMemberIds([pending.labelId, ...duplicateIds]), (names) => [
                ...new Set(names.map((n) => (keys.includes(normalizeLabelName(n)) ? label.name : n))),
            ]);

            for (const id of duplicateIds) {
                this.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
                this.emitLabel(SSEventType.LABEL_DELETED, id);
            }
            this.clearPendingRename(pending.labelId);
        }
    }

    private clearPendingRename(labelId: string): void {
        this.db.delete(schema.pendingLabelRenames).where(eq(schema.pendingLabelRenames.labelId, labelId)).run();
    }

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
        // A name that normalizes to nothing is not storable: syncCardLabels skips the empty key, so every
        // membership assigned to such a label would be dropped while the save reported success.
        const nameKey = normalizeLabelName(label.name);
        if (!nameKey) throw new ApiError(400, 'Label name is required');

        return this.writeLock.run(async () => {
            await this.drainDirty();
            await this.resumeLabelRenames();
            const labelId = randomUUID();

            try {
                await this.db.insert(schema.labels).values({
                    id: labelId,
                    name: label.name.trim(),
                    nameKey,
                    color: label.color,
                    createdAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                });
            } catch (e) {
                rethrowDuplicateLabelName(e);
            }

            this.emitLabel(SSEventType.LABEL_CREATED, labelId);

            return labelId;
        });
    }

    public async updateLabel(id: string, label: Omit<Label, 'id'>): Promise<Label> {
        // Same refusal as addLabel, and before the rename fan-out: an empty name would rewrite every member
        // card's CATEGORIES to a value the junction can no longer resolve.
        const nameKey = normalizeLabelName(label.name);
        if (!nameKey) throw new ApiError(400, 'Label name is required');

        return this.writeLock.run(async () => {
            await this.drainDirty();
            await this.resumeLabelRenames();

            const before = this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
            if (!before) throw new ApiError(404, 'Label not found');
            // Only a display-name change touches cards — the color never appears in a vCard.
            const newName = label.name.trim();
            const renamedFrom = before.name !== newName ? before : undefined;

            try {
                this.db.transaction((tx) => {
                    tx.update(schema.labels)
                        .set({
                            name: newName,
                            nameKey,
                            color: label.color,
                            updatedAt: sql`unixepoch()`,
                        })
                        .where(eq(schema.labels.id, id))
                        .run();

                    // The fan-out is owed from the moment the row changes, so the intent is durable from that
                    // same moment: the member files a crash never reaches stay stat-clean, and no reconcile
                    // can find them (the proposal's original no-journal claim — see PROPOSAL_CARDDAV.md § 1 amendment).
                    if (renamedFrom) {
                        tx.insert(schema.pendingLabelRenames)
                            .values({ labelId: id, oldName: renamedFrom.name, newName })
                            .run();
                    }
                });
            } catch (e) {
                rethrowDuplicateLabelName(e);
            }

            // The old name is matched case-insensitively (CATEGORIES may carry a different case than the
            // label's stored name).
            if (renamedFrom) {
                const oldNameKey = renamedFrom.nameKey;
                try {
                    await this.rewriteCardCategories(this.labelMemberIds([id]), (names) =>
                        names.map((n) => (normalizeLabelName(n) === oldNameKey ? newName : n)),
                    );
                    this.clearPendingRename(id);
                } catch (forwardError) {
                    try {
                        await this.db
                            .update(schema.labels)
                            .set({
                                name: renamedFrom.name,
                                nameKey: renamedFrom.nameKey,
                                color: renamedFrom.color,
                                updatedAt: renamedFrom.updatedAt,
                            })
                            .where(eq(schema.labels.id, id));
                        await this.rewriteCardCategories(this.labelMemberIds([id]), (names) =>
                            names.map((n) => (normalizeLabelName(n) === nameKey ? renamedFrom.name : n)),
                        );
                        this.clearPendingRename(id);
                    } catch (rollbackError) {
                        // The record stays: the next init (or label mutation) resumes the cards onto whatever
                        // name the row ended up carrying.
                        console.error(`contacts: failed to compensate label rename ${id}:`, rollbackError);
                    }
                    throw forwardError;
                }
            }

            this.emitLabel(SSEventType.LABEL_UPDATED, id);
            // Reaching here means the row committed this exact name and color — the fan-out's only other exit
            // is a throw — so the DTO is assembled instead of read back with the bookkeeping columns.
            return { id, name: newName, color: label.color };
        });
    }

    public async deleteLabel(id: string): Promise<void> {
        return this.writeLock.run(async () => {
            await this.drainDirty();
            // Converge a half-applied rename first, so the delete below removes the name the cards actually
            // carry. The pending record itself cascades away with the label row.
            await this.resumeLabelRenames();

            const label = this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
            if (label) {
                const { nameKey } = label;
                await this.rewriteCardCategories(this.labelMemberIds([id]), (names) =>
                    names.filter((n) => normalizeLabelName(n) !== nameKey),
                );
            }

            // The junction rows cascade with the label row (FK ON DELETE CASCADE); the fan-out has already
            // rewritten every member's CATEGORIES.
            this.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
            this.emitLabel(SSEventType.LABEL_DELETED, id);
        });
    }

    private dbRowToContact(row: typeof schema.contacts.$inferSelect, labels: string[]): Contact {
        const data = row.data ?? EMPTY_CARD_DATA;

        return {
            id: row.id,
            firstName: row.firstName.trim(),
            lastName: row.lastName.trim(),
            eigenId: row.eigenId,
            etag: row.etag,
            ...data,
            labels,
        };
    }

    public async getContactById(id: string): Promise<Contact | null> {
        await this.ensureDrained();
        const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
        if (!row || row.isGroup) return null;
        const labels = this.db
            .select({ labelId: schema.contactsToLabels.labelId })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.contactId, row.id))
            .all()
            .map((rel) => rel.labelId);
        return this.dbRowToContact(row, labels);
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

    // Stage two first-generation siblings from the pristine upload: the 512px webp Eigen serves (alpha and
    // animation preserved natively) and an Apple-safe embed for the vCard PHOTO. Both are decoded from the
    // original — never chained through one another — so a save can embed the embed verbatim and promote the
    // webp to the cache, and the app/DAV both get generation one. Only the webp url is returned; the embed
    // sibling rides beside it under `<uuid>.embed.<ext>` for `resolveStagedAvatar` to pair up at save time.
    public async uploadAvatar(file: File): Promise<string> {
        this.cleanupAvatarImages().catch(() => {});

        const buffer = Buffer.from(await file.arrayBuffer());
        const webp = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', AVATAR_PREVIEW);
        if (!webp) throw new ApiError(400, 'Failed to generate avatar thumbnail');

        // Animation wins over alpha (a GIF always reports hasAlpha), so an animated source embeds as GIF, an
        // opaque still as JPEG q80, and anything else carrying transparency as PNG.
        let format: EmbedFormat = webp.frameCount > 1 ? 'gif' : webp.hasAlpha ? 'png' : 'jpeg';
        let embed = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', {
            ...AVATAR_PREVIEW,
            format,
        });
        if (!embed) throw new ApiError(400, 'Failed to generate avatar thumbnail');
        if (format === 'gif' && embed.data.byteLength > AVATAR_EMBED_GIF_MAX_BYTES) {
            const jpeg = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', {
                ...AVATAR_PREVIEW,
                format: 'jpeg',
            });
            if (!jpeg) throw new ApiError(400, 'Failed to generate avatar thumbnail');
            embed = jpeg;
            format = 'jpeg';
        }

        const webpName = `${randomUUID()}.webp`;
        const embedName = stagedEmbedName(webpName, format);
        // The encodes stay outside the lock (the slow part, no accounting); the writes and their byte delta take
        // it, so the sweep's recount can never land between them and lose the increment.
        await this.writeLock.run(async () => {
            await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${webpName}`, webp.data);
            await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${embedName}`, embed.data);
            this.avatarsBytes += webp.data.byteLength + embed.data.byteLength;
        });

        return avatarUrl(this.home.user.id, webpName);
    }

    public async downloadAvatar(filename: string): Promise<ArrayBuffer | null> {
        if (!AVATAR_FILENAME.test(filename)) {
            return null;
        }
        const file = this.storage.file(`${PATHS.CONTACTS.AVATARS}/${filename}`);
        if (!(await file.exists())) {
            return null;
        }
        return file.arrayBuffer();
    }

    // Pair a staged upload back up: the Apple-safe embed bytes a save writes verbatim into PHOTO, and the
    // first-generation webp sibling it promotes to the cache. No transcode here — both were encoded once at
    // staging (uploadAvatar). Null for an empty url; a non-empty url whose webp or embed sibling is gone (swept,
    // a torn upload) throws so the caller re-uploads rather than silently dropping a photo the user meant to set.
    private async resolveStagedAvatar(stagedUrl: string | undefined): Promise<StagedAvatarPair | null> {
        if (!stagedUrl) return null;
        const webpName = stagedUrl.split('/').pop()!;
        const webp = await this.downloadAvatar(webpName);
        let embed: { bytes: Uint8Array; mediaType: string } | null = null;
        if (webp) {
            // The candidate names derive from a webp name the allowlist already accepted (downloadAvatar), so the
            // embed path is safe by construction; exactly one sibling extension is ever written per upload.
            for (const cand of stagedEmbedCandidates(webpName)) {
                const path = `${PATHS.CONTACTS.AVATARS}/${cand.name}`;
                if (await this.storage.exists(path)) {
                    embed = {
                        bytes: new Uint8Array(await this.storage.file(path).arrayBuffer()),
                        mediaType: cand.mediaType,
                    };
                    break;
                }
            }
        }
        if (!webp || !embed) {
            throw new ApiError(400, 'Avatar upload could not be found — please upload it again');
        }
        return { embed, webp: new Uint8Array(webp) };
    }

    // Save-seam cache write: store the staged first-generation webp sibling under the embed-derived cache name
    // (avatarCacheName over the EMBED bytes — the same name a later reindex derives from the card's PHOTO). The
    // app then serves generation one; a reconcile that finds this name keeps the file, and only a changed embed
    // yields a new name and re-derivation. Mirrors cacheCardPhoto's replaced-bytes accounting.
    private async promoteAvatarCache(contactId: string, staged: StagedAvatarPair): Promise<string> {
        const name = avatarCacheName(contactId, staged.embed.bytes);
        const path = `${PATHS.CONTACTS.AVATARS}/${name}`;
        const replaced = (await this.storage.size(path)) ?? 0;
        await this.storage.write(path, staged.webp);
        this.avatarsBytes += staged.webp.byteLength - replaced;
        return avatarUrl(this.home.user.id, name);
    }

    // Derive the webp avatar cache from an inline PHOTO and return its projection URL — the regeneration path
    // (a reindex after avatars/ loss, an external DAV PUT), one generation older than a save's promoted webp.
    // The 512px webp target decodes every format: a JPEG/PNG embed becomes an opaque/alpha webp, an animated
    // GIF becomes an animated webp (the worker reads all pages for webp), each a full frame — never a filmstrip.
    // Naming by the embedded bytes' hash makes a superseded photo's file fall out of reference, so
    // cleanupAvatarImages sweeps it. A uri-kind or absent photo caches nothing — remote URIs are never fetched
    // (SSRF, spec Non-goals).
    private async cacheCardPhoto(contactId: string, photo: ParsedCardPhoto | null): Promise<string> {
        if (photo?.kind !== 'inline') return '';
        const result = await generateImagePreview(
            Buffer.from(photo.bytes),
            photo.mediaType ?? 'image/jpeg',
            'avatar',
            '',
            'avatar',
            AVATAR_PREVIEW,
        );
        if (!result) return '';
        const name = avatarCacheName(contactId, photo.bytes);
        const path = `${PATHS.CONTACTS.AVATARS}/${name}`;
        // Re-deriving the same photo (a drained write, a reconcile, a re-upload of the same image) overwrites
        // the hash-named file rather than adding one, so credit the bytes it replaces.
        const replaced = (await this.storage.size(path)) ?? 0;
        await this.storage.write(path, result.data);
        this.avatarsBytes += result.data.byteLength - replaced;
        return avatarUrl(this.home.user.id, name);
    }

    // Reclaim avatar files no indexed row references any more, then re-seed the running total from disk.
    // Runs under the write lock — every other avatarsBytes mutation holds it too, so the closing recount can
    // no longer clobber a delta an interleaved write applied mid-sweep.
    private cleanupAvatarImages(): Promise<void> {
        return this.writeLock.run(async () => {
            await this.storage.mkdir(PATHS.CONTACTS.AVATARS);
            const files = await this.storage.list(PATHS.CONTACTS.AVATARS);

            // Build the referenced-filename set once, then sweep — O(avatars + contacts), not O(avatars × contacts).
            // Read the projection straight from the index: the public list would re-enter the lock this holds,
            // and it hides group rows, whose photo caches are referenced all the same.
            const referenced = new Set(
                this.db
                    .select({ data: schema.contacts.data })
                    .from(schema.contacts)
                    .all()
                    .map((row) => row.data?.avatar?.split('/').pop())
                    .filter((name): name is string => !!name),
            );

            const now = Date.now();
            for (const file of files) {
                if (referenced.has(file)) continue;
                // A freshly-staged upload has no card pointing at it yet; leave it inside the grace window so an
                // in-progress edit's avatar isn't swept out from under the save.
                const stat = await this.storage.stat(`${PATHS.CONTACTS.AVATARS}/${file}`);
                if (now - stat.mtimeMs < AVATAR_STAGE_GRACE_MS) continue;
                await this.storage.delete(`${PATHS.CONTACTS.AVATARS}/${file}`);
            }

            this.avatarsBytes = await this.storage.dirSize(PATHS.CONTACTS.AVATARS);
        });
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

    // ---- CardDAV store seam ----
    // The index-only reads the protocol handlers (Tasks 14–18) sit on. Each drains a pending failed pair before
    // observing the index so no DAV read is served past a torn write (fail-closed, spec § 1), exactly as
    // getContacts does — which is why they are async even where the shape looks synchronous.

    public async getBook(): Promise<CardBook> {
        await this.ensureDrained();
        const book = this.db.select().from(schema.book).where(eq(schema.book.id, 1)).get()!;
        return { ctag: book.ctag, syncGen: book.syncGen };
    }

    // Every resource in the book — group cards included, since DAV serves the whole book (the app list hides them).
    public async listCards(): Promise<CardRow[]> {
        await this.ensureDrained();
        return this.db
            .select({ uri: schema.contacts.uri, etag: schema.contacts.etag, isGroup: schema.contacts.isGroup })
            .from(schema.contacts)
            .all();
    }

    // The rows changed after book token N — the sync-collection delta (cardCtag is stamped on every change).
    public async getChangedCardsSince(sinceCtag: number): Promise<CardRow[]> {
        await this.ensureDrained();
        return this.db
            .select({ uri: schema.contacts.uri, etag: schema.contacts.etag, isGroup: schema.contacts.isGroup })
            .from(schema.contacts)
            .where(gt(schema.contacts.cardCtag, sinceCtag))
            .all();
    }

    // The uris removed after book token N — the sync-collection 404 rows (one row per uri, no duplicate hrefs).
    public async getDeletedCardsSince(sinceCtag: number): Promise<{ uri: string }[]> {
        await this.ensureDrained();
        return this.db
            .select({ uri: schema.contactTombstones.uri })
            .from(schema.contactTombstones)
            .where(gt(schema.contactTombstones.deletedAtCtag, sinceCtag))
            .all();
    }

    // The stored bytes for a resource (GET/multiget). Looks the row up by its folded key, then reads the file
    // under its canonical uri. A row whose file has vanished is not a 500: mark it so the next drain tombstones
    // it (the vanished-file branch) and answer this request as a miss.
    public async getCard(uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
        await this.ensureDrained();
        const row = this.db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get();
        if (!row) return null;
        try {
            return { bytes: await this.readCardBytes(row.uri), etag: row.etag };
        } catch (e) {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
                this.markCardDirty(row.uri);
                return null;
            }
            throw e;
        }
    }

    // The resource metadata (canonical uri + etag) for one card by its folded key — the single-resource
    // PROPFIND read. An indexed single-row lookup, unlike a `listCards().find()` over the whole book; getCard
    // is the wrong tool here because it reads the file bytes a PROPFIND never returns.
    public async getCardMeta(uri: string): Promise<CardRow | null> {
        await this.ensureDrained();
        return (
            this.db
                .select({ uri: schema.contacts.uri, etag: schema.contacts.etag, isGroup: schema.contacts.isGroup })
                .from(schema.contacts)
                .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
                .get() ?? null
        );
    }

    // A DAV PUT: store the client's card verbatim (after the 4.0→3.0 transcode) as the resource, with every
    // precondition, UID rule, quota gate, and self-link decision evaluated INSIDE the writeLock against the
    // state the write overwrites (§ 3). The uri is the client-chosen filename; the router sanitizes it (§ 4)
    // but this is a public method that turns the uri into a filesystem path, so it re-validates before any
    // write — a traversal or otherwise-unsafe name is refused, never renamed over a sibling file. Mirrors the
    // addContact/updateContact write seam.
    public async putCard(
        uri: string,
        body: string,
        pre: { ifMatch: string | null; ifNoneMatch: string | null },
    ): Promise<PutCardResult> {
        if (sanitizeCardUri(uri) !== uri) return { ok: false, error: 'invalid' };
        return this.writeLock.run(async (): Promise<PutCardResult> => {
            await this.drainDirty();

            // The raw body is bounded before any parse so a hostile multi-MiB payload never reaches the AST
            // unfolder (§ 4); enforceCardBudget re-checks the same ceiling on the stored bytes below.
            if (Buffer.byteLength(body) > CARD_MAX_BYTES) return { ok: false, error: 'too-large' };

            // The book is 3.0 on disk: a 4.0 client's card is transcoded (identity for 3.0), then parsed for the
            // index projection. Anything that isn't one well-formed vCard is a client error, not a 500.
            let parsed: ParsedCard;
            let stored: string;
            try {
                stored = transcodeTo30(body);
                parsed = parseVCard(stored);
            } catch {
                return { ok: false, error: 'invalid' };
            }

            // Preconditions, against the state the write will overwrite: two racing If-Match PUTs serialize
            // through the lock, so the loser sees the winner's new etag and fails here.
            const existing = this.db
                .select()
                .from(schema.contacts)
                .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
                .get();
            const currentEtag = existing?.etag ?? null;
            if (pre.ifNoneMatch !== null && preconditionMatches(pre.ifNoneMatch, currentEtag)) {
                return { ok: false, error: 'precondition' };
            }
            if (pre.ifMatch !== null && !preconditionMatches(pre.ifMatch, currentEtag)) {
                return { ok: false, error: 'precondition' };
            }

            // On update, the write keeps the incumbent's on-disk spelling: matching is case/normalization
            // insensitive (uriKey), but a case-variant PUT must rewrite the existing file in place — writing
            // under the caller's spelling would strand the old file on a case-sensitive fs and let the next
            // reconcile re-index from its stale bytes (silently reverting the accepted write).
            const storedUri = existing?.uri ?? uri;

            // A card carries one UID for its life: it is required, immutable on update, and a UID already owned
            // by another resource is a conflict, never a raw idx_contacts_uid 500 (§ 3/§ 4).
            if (!parsed.uid) return { ok: false, error: 'invalid', message: 'UID is required' };
            if (existing) {
                if (parsed.uid !== existing.uid) return { ok: false, error: 'uid-conflict' };
            } else if (
                this.db
                    .select({ id: schema.contacts.id })
                    .from(schema.contacts)
                    .where(eq(schema.contacts.uid, parsed.uid))
                    .get()
            ) {
                return { ok: false, error: 'uid-conflict' };
            }

            // Resolve the self-link (and restore X-EIGEN-ID into the bytes when this card holds the link but its
            // payload dropped it) before the quota gate, so the meter and the returned etag both hash the exact
            // bytes written.
            const { eigenId, bytes } = this.resolveSelfLinkOnPut(parsed, new TextEncoder().encode(stored), existing);

            // The stored bytes credit the card this one replaces (0 on create). enforceCardBudget raises 413 for
            // the whole-card ceiling and 507 for the mail+contacts quota; map both to typed results.
            try {
                await this.enforceCardBudget(bytes, existing?.size ?? 0);
            } catch (e) {
                if (e instanceof ApiError && e.status === 413) return { ok: false, error: 'too-large' };
                if (e instanceof ApiError && e.status === 507) return { ok: false, error: 'quota' };
                throw e;
            }

            const id = existing?.id ?? randomUUID();
            const isSelf = eigenId === this.home.user.id;

            // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
            // drain and rethrows, and the durable intent recorded first covers a process death.
            let projectionAvatar = '';
            let etag = '';
            try {
                this.recordCardWrite(storedUri);
                const { mtime, size } = await writeCardFile(this.storage, storedUri, bytes);
                etag = computeCardEtag(bytes);
                // Inline PHOTO → derived webp cache; the projection stores its URL (a uri/absent photo → '').
                projectionAvatar = await this.cacheCardPhoto(id, parsed.photo);
                this.commitCard({
                    row: {
                        id,
                        uri: storedUri,
                        uriKey: uriKeyOf(storedUri),
                        uid: parsed.uid,
                        firstName: parsed.firstName.trim(),
                        lastName: parsed.lastName.trim(),
                        eigenId,
                        isGroup: parsed.isGroup,
                        data: {
                            email: parsed.email,
                            phone: parsed.phone,
                            company: parsed.company,
                            jobTitle: parsed.jobTitle,
                            address: parsed.address,
                            birthday: parsed.birthday,
                            notes: parsed.notes,
                            avatar: projectionAvatar,
                        },
                        etag,
                        mtime: Math.round(mtime),
                        size,
                    },
                    categories: parsed.categories,
                    // A create re-using a tombstoned uri clears its removal in the same transaction, so no href
                    // is ever both a 200 and a 404 in one sync response (§ 1, single-href guarantee).
                    tombstoneCleared: true,
                });
                this.cardsBytes += size - (existing?.size ?? 0);
            } catch (e) {
                this.markCardDirty(storedUri);
                throw e;
            }

            // A self-card PUT renames the user org-wide, exactly as updateContact's push does — after the commit,
            // failure logged never rethrown. A DAV PUT carries no staged avatar URL, so the pushed bytes are the
            // derived webp cache (the generation-one image Eigen serves); no photo → null clears the server avatar.
            if (isSelf) {
                let avatarWebP: Buffer | null = null;
                if (projectionAvatar) {
                    const data = await this.downloadAvatar(projectionAvatar.split('/').pop()!);
                    if (data) avatarWebP = Buffer.from(data);
                }
                try {
                    await pushUserProfile(
                        this.home.user.id,
                        `${parsed.firstName.trim()} ${parsed.lastName.trim()}`.trim(),
                        avatarWebP,
                    );
                } catch (e) {
                    console.error(`contacts: failed to propagate the profile of ${this.home.user.id}:`, e);
                }
            }

            this.emitContact(existing ? SSEventType.CONTACT_UPDATED : SSEventType.CONTACT_CREATED, id);
            return { ok: true, etag, created: !existing };
        });
    }

    // A DAV DELETE: an unknown uri is a 404 (deliberately unlike REST's idempotent no-op), your own card is a
    // 403, and a stale If-Match is a 412 — then the shared purge tail removes the file, tombstone, byte total,
    // and derived avatar under the lock.
    public async deleteCard(
        uri: string,
        pre: { ifMatch: string | null },
    ): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'precondition' | 'self-delete' }> {
        return this.writeLock.run(
            async (): Promise<{ ok: true } | { ok: false; error: 'not-found' | 'precondition' | 'self-delete' }> => {
                await this.drainDirty();
                const row = this.db
                    .select()
                    .from(schema.contacts)
                    .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
                    .get();
                if (!row) return { ok: false, error: 'not-found' };
                // Self before etag, mirroring deleteContact: your own card cannot be removed regardless of token.
                if (row.eigenId === this.home.user.id) return { ok: false, error: 'self-delete' };
                if (pre.ifMatch !== null && !preconditionMatches(pre.ifMatch, row.etag)) {
                    return { ok: false, error: 'precondition' };
                }
                await this.purgeCard(row);
                return { ok: true };
            },
        );
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
