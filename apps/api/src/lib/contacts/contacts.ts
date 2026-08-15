import { randomUUID } from 'node:crypto';
import type { Address, Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import type { ParsedCard, ParsedCardPhoto } from '../carddav/vcard-parse';
import { normalizeBirthday, parseVCard } from '../carddav/vcard-parse';
import { type CardEdits, createVCard, mergeVCard } from '../carddav/vcard-serialize';
import { getServerSettings } from '../config/server-settings';
import type { ManagedDatabase } from '../core';
import { ApiError, DEFAULT_LABELS, LocalFilesystem, PATHS } from '../core';
import type { Home } from '../home';
import { getHome } from '../home';
import { pushUserProfile } from '../home/home-relay';
import { generateImagePreview } from '../shared/thumbnails';
import type { User } from '../user';
import { getOrgOwner } from '../user/';
import {
    avatarCacheName,
    avatarUrl,
    CARDS_DIR,
    cardPath,
    cleanupTempCardFiles,
    computeCardEtag,
    labelColorFor,
    listCardUris,
    normalizeLabelName,
    uriKeyOf,
    writeCardFile,
} from './card-store';
import { CONTACTS_DB_CONFIG } from './db-config';
import * as schema from './schema';
import { buildContactEvent, buildLabelEvent } from './sse-events';

export async function getContacts(user: User) {
    const home = await getHome(user.id);
    return home.contacts;
}

async function getContactsDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CONTACTS_DB_CONFIG, 'eigen.contacts/contacts.db');
}

// The columns a card (re)index computes; the ctag + timestamps are stamped inside the write transaction.
type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;

// The only incumbent-row scalars the candidate build reads: a stable contact id, the uid fallback, and the
// eigenId that ranks a self-link claim. The reconcile/rebuild passes project these (never the `data` JSON) so
// init never parses a stored projection.
type IndexIncumbent = Pick<typeof schema.contacts.$inferSelect, 'id' | 'uid' | 'eigenId'>;

// The index-stored projection: the owned properties minus what lives in dedicated columns (names/eigenId)
// or the junction (labels). `avatar` is the cache URL only — inline photo bytes never enter the index.
// Optionals collapse to '' / [] so this emits the exact same canonical shape prepareCardRow does — the
// update seam's `avatarChanged` diff (and any projection compare) then can't misfire on `undefined !== ''`.
function toData(contact: Omit<Contact, 'id'>): (typeof schema.contacts.$inferInsert)['data'] {
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

// The web form seeds a blank email, a blank phone, and an all-empty address (emptyContact). Drop those at the
// write seam so form-created cards never carry a bare EMAIL:/TEL:/ADR: line out to DAV clients.
function isBlankAddress(a: Address): boolean {
    return (
        !(a.street ?? '').trim() &&
        !(a.city ?? '').trim() &&
        !(a.state ?? '').trim() &&
        !(a.zipCode ?? '').trim() &&
        !(a.country ?? '').trim()
    );
}

// A freshly-staged avatar has no card referencing it yet — the user is still filling in the form. Give an
// upload an hour before the unreferenced-avatar sweep may reclaim it, so an in-progress edit's staged webp
// isn't deleted out from under the save.
const AVATAR_STAGE_GRACE_MS = 60 * 60 * 1000;

// Every contact-photo transcode shares one preview shape: a 512px q80 square-cropped image. The upload/cache
// seams keep webp; resolveStagedAvatar spreads it with format:'jpeg' because Apple Contacts can't decode webp
// contact photos and a q80 JPEG stays under its 224 KB per-photo ceiling.
const AVATAR_PREVIEW = { maxSize: 512, quality: 80, fit: 'cover' } as const;

// The v2 UNIQUE index on labels(nameKey) closes duplicate/case-variant label names. bun:sqlite names the
// column in the violation message ("UNIQUE constraint failed: labels.nameKey"); match on it so an unrelated
// UNIQUE (the id PRIMARY KEY) still surfaces as a real error rather than a spurious 409.
function rethrowDuplicateLabelName(e: unknown): never {
    if (e instanceof Error && e.message.includes('labels.nameKey')) {
        throw new ApiError(409, 'A label with this name already exists');
    }
    throw e;
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
    private dirtyCards = new Set<string>();

    // Backs `cardParseCount`, the spec's performance-invariant test hook: only the reconcile/rebuild/drain
    // machinery bumps this (via `parseCardFile`); the mutation paths parse for their own merges.
    private cardParses = 0;

    // Running byte totals so size() answers from memory — enforceContactsIngest calls it on every DAV PUT,
    // and a directory walk per call would make an N-card device sync O(N²) stats (spec Performance invariants).
    private cardsBytes = 0;
    private avatarsBytes = 0;

    constructor(home: Home) {
        this.home = home;
        this.storage = new LocalFilesystem(`${home.homeDir}/eigen.contacts`);
    }

    private emitContact(type: Parameters<typeof buildContactEvent>[0], contactId: string): void {
        this.home.broadcast(buildContactEvent(type, contactId));
    }

    private emitLabel(type: Parameters<typeof buildLabelEvent>[0], labelId: string): void {
        this.home.broadcast(buildLabelEvent(type, labelId));
    }

    public async init() {
        this.managedDb = await getContactsDatabase(this.home);
        this.db = this.managedDb.db;

        await this.storage.mkdir(CARDS_DIR);
        await cleanupTempCardFiles(this.storage);

        // Seed the avatar byte total from disk once; every avatar write/delete adjusts it by delta thereafter.
        // cardsBytes is owned by the reconcile/rebuild pass below (it sums the cards it indexes, garbage excluded).
        this.avatarsBytes = await this.storage.dirSize(PATHS.CONTACTS.AVATARS);

        // Bring the index in line with cards/ before seeding: a stat-only reconcile on a healthy book, or a
        // full rebuild if the book/sync bookkeeping is gone (rebuild re-derives it from the files).
        if (this.indexIsIntact()) await this.reconcileIndex();
        else await this.rebuildIndex();

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

        this.cleanupAvatarImages().catch(() => {});
    }

    public async size(): Promise<number> {
        await this.ensureDrained();
        return this.cardsBytes + this.avatarsBytes;
    }

    // UPDATE book SET ctag = ctag + 1 and read the new value back — matches the calendar bookkeeping.
    private bumpCtag(tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0]): number {
        tx.update(schema.book)
            .set({ ctag: sql`${schema.book.ctag} + 1` })
            .where(eq(schema.book.id, 1))
            .run();
        return tx.select({ ctag: schema.book.ctag }).from(schema.book).where(eq(schema.book.id, 1)).get()!.ctag;
    }

    // Upsert a removal tombstone keyed by uri (carrying the folded uriKey so a re-created case-variant card
    // clears it), stamped with the current ctag. One shape shared by drainDirty, reconcile and deleteContact.
    private tombstone(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        uri: string,
        uriKey: string,
        ctag: number,
    ): void {
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
    private syncCardLabels(
        tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
        contactId: string,
        categories: string[],
        createdLabelIds: string[],
    ): void {
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
            this.dirtyCards.delete(uri);
        }
    }

    private markCardDirty(uri: string): void {
        this.dirtyCards.add(uri);
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
    private pickSelfWinner<T extends { rank: number }>(candidates: T[]): T | undefined {
        let winner: T | undefined;
        for (const c of candidates) {
            if (c.rank > 0 && (!winner || c.rank > winner.rank)) winner = c;
        }
        return winner;
    }

    // Stamp the chosen winner's row with the self-link and, when its file does not already assert the link,
    // restore X-EIGEN-ID into that one file and re-stat/re-etag it — the § 2 durability rewrite, covering an
    // email-only claim and an incumbent whose file a client stripped. No loser's file is ever touched.
    private async applySelfLink(winner: { row: CardRowInput; parsed: ParsedCard }): Promise<void> {
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
    private dedupeByUid<T extends { row: CardRowInput }>(candidates: T[], uidOwner: Map<string, string>): T[] {
        const kept: T[] = [];
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
    // or one that vanished mid-pass) is skipped-and-logged rather than failing the whole pass (spec § 1). The
    // incumbent rides through on each candidate so the caller can tell a new card from an updated one.
    private async buildCandidates(entries: { uri: string; existing?: IndexIncumbent }[]): Promise<
        {
            row: CardRowInput;
            categories: string[];
            parsed: ParsedCard;
            existing?: IndexIncumbent;
            rank: 0 | 1 | 2 | 3;
        }[]
    > {
        const candidates: {
            row: CardRowInput;
            categories: string[];
            parsed: ParsedCard;
            existing?: IndexIncumbent;
            rank: 0 | 1 | 2 | 3;
        }[] = [];
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

    // Stat-only reconcile: list cards/, compare (mtime,size) to the index, and re-read only what drifted — the
    // clean case (always, in practice) is one listing plus stats, zero file reads. New/drifted cards are
    // re-indexed and vanished rows tombstoned under a single ctag bump; a fully clean pass parses nothing and
    // bumps nothing (spec § 1). A same-size, timestamp-preserving replacement is invisible here — that needs
    // `rebuildIndex`.
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

            // Project only the scalars the pass reads — never the `data` JSON — so a clean init parses nothing.
            const rows = this.db
                .select({
                    id: schema.contacts.id,
                    uri: schema.contacts.uri,
                    uriKey: schema.contacts.uriKey,
                    uid: schema.contacts.uid,
                    mtime: schema.contacts.mtime,
                    size: schema.contacts.size,
                    eigenId: schema.contacts.eigenId,
                })
                .from(schema.contacts)
                .all();
            const rowByKey = new Map(rows.map((r) => [r.uriKey, r] as const));

            const reindex: { uri: string; existing?: (typeof rows)[number] }[] = [];
            for (const [key, info] of present) {
                const existing = rowByKey.get(key);
                if (!existing || info.mtime !== existing.mtime || info.size !== existing.size) {
                    reindex.push({ uri: info.uri, existing });
                }
            }
            const vanished = rows.filter((r) => !present.has(r.uriKey) && !skipped.has(r.uriKey));

            if (reindex.length === 0 && vanished.length === 0) {
                // A clean pass still owns cardsBytes: the present files ARE the indexed cards, so sum them here
                // (the seam init once did from disk) without any parse or ctag bump.
                this.cardsBytes = [...present.values()].reduce((sum, p) => sum + p.size, 0);
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

            // Phase 2: choose the one self-link winner. A self row that survives this pass untouched (file
            // present AND not re-indexing) holds the slot outright; the present() guard stops a self row whose
            // file vanished — tombstoned this same pass — from blocking a twin's claim.
            const survivingSelf = rows.some(
                (r) => r.eigenId === this.home.user.id && !reindexKeys.has(r.uriKey) && present.has(r.uriKey),
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

            this.cardsBytes = prepared.reduce((sum, p) => sum + p.row.size, 0);
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

    public async addContact(contact: Omit<Contact, 'id'>): Promise<string> {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            // Normalize the birthday to a bare date at the seam so every writer (createVCard + toData) agrees
            // and an app-set ISO datetime reaches the file as a plain BDAY (spec files-as-truth).
            contact.birthday = normalizeBirthday(contact.birthday ?? '');

            // Drop the form's placeholder blank email/phone/address so no bare property line reaches the file.
            contact.email = contact.email.filter((e) => e.trim() !== '');
            contact.phone = contact.phone.filter((p) => p.trim() !== '');
            contact.address = (contact.address ?? []).filter((a) => !isBlankAddress(a));

            const id = randomUUID();
            const uri = `${id}.vcf`;
            const categories = this.labelNamesFor(contact.labels ?? []);
            // resolveStagedAvatar throws when a non-empty avatar can't be resolved (its staged file was swept),
            // so a create with a vanished upload fails here rather than silently dropping the photo.
            const photo = await this.resolveStagedAvatar(contact.avatar);

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
                        photo: photo ?? undefined,
                    },
                    id,
                ),
            );

            // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
            // drain and rethrows.
            try {
                const { mtime, size } = await writeCardFile(this.storage, uri, bytes);
                // The avatar cache is derived from the embed; the projection stores its hashed URL (or '' if none).
                contact.avatar = await this.cacheCardPhoto(
                    id,
                    photo ? { kind: 'inline', bytes: photo.bytes, mediaType: photo.mediaType } : null,
                );
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

    public async updateContact(id: string, contact: Omit<Contact, 'id'>, expectedEtag?: string): Promise<void> {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            // Normalize the birthday at the seam (see addContact) so the merge diff and toData see the same
            // bare date — echoing a phone's BDAY is then a no-op, and an app edit reaches the file.
            contact.birthday = normalizeBirthday(contact.birthday ?? '');

            // Drop the form's placeholder blank email/phone/address (before the self-card own-email prepend
            // below) so no bare property line reaches the file.
            contact.email = contact.email.filter((e) => e.trim() !== '');
            contact.phone = contact.phone.filter((p) => p.trim() !== '');
            contact.address = (contact.address ?? []).filter((a) => !isBlankAddress(a));

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
            // avatar resolves the staged webp to an embedded JPEG (or throws if its staged file was swept — a
            // silent strip would lose a photo the user meant to replace); an explicit clear (avatar === '')
            // removes PHOTO. The derived cache + projection URL are rebuilt from the embed after the write.
            const avatarChanged = contact.avatar !== (row.data?.avatar ?? '');
            let photo: { bytes: Uint8Array; mediaType: string } | null = null;
            if (avatarChanged) {
                if (contact.avatar) {
                    photo = await this.resolveStagedAvatar(contact.avatar);
                }
                edits.photo = photo;
            }

            const bytes = new TextEncoder().encode(mergeVCard(card, edits));

            // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
            // drain and rethrows.
            try {
                const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
                if (avatarChanged) {
                    contact.avatar = await this.cacheCardPhoto(
                        id,
                        photo ? { kind: 'inline', bytes: photo.bytes, mediaType: photo.mediaType } : null,
                    );
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
            if (isSelf) await pushUserProfile(this.home.user.id, selfName, selfAvatarBuffer);
            this.emitContact(SSEventType.CONTACT_UPDATED, id);
        });
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
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, id)).run();
                    this.tombstone(tx, row.uri, row.uriKey, ctag);
                });
            } catch (e) {
                this.markCardDirty(row.uri);
                throw e;
            }

            this.cardsBytes -= row.size;
            const avatarName = row.data?.avatar?.split('/').pop();
            const ownedAvatarPrefix = `${row.id}-`;
            // Historical rows may share staged or legacy names; only this row's hash cache is safe to unlink.
            if (
                avatarName?.startsWith(ownedAvatarPrefix) &&
                /^[0-9a-f]{8}\.webp$/.test(avatarName.slice(ownedAvatarPrefix.length))
            ) {
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
            this.emitContact(SSEventType.CONTACT_DELETED, id);
        });
    }

    public async getLabels(): Promise<Label[]> {
        await this.ensureDrained();
        return this.db.select().from(schema.labels).all();
    }

    // A label rename/delete fans out to every member card so CATEGORIES stays the membership truth: each
    // card is re-read, its category names remapped by `transform`, then written and re-indexed through the
    // same file→commit pipeline as a contact edit (its etag/cardCtag bump, so DAV clients re-fetch). Callers
    // hold the writeLock and drive it directly rather than via updateContact, which would re-enter the
    // non-reentrant lock.
    private async rewriteLabelInMemberCards(labelId: string, transform: (names: string[]) => string[]): Promise<void> {
        const memberIds = this.db
            .select({ contactId: schema.contactsToLabels.contactId })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.labelId, labelId))
            .all()
            .map((r) => r.contactId);

        for (const contactId of memberIds) {
            const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).get();
            if (!row) continue;

            const card = parseVCard(new TextDecoder().decode(await this.readCardBytes(row.uri)));
            const categories = transform(card.categories);
            const bytes = new TextEncoder().encode(mergeVCard(card, { categories }));

            try {
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

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
        return this.writeLock.run(async () => {
            await this.drainDirty();
            const labelId = randomUUID();

            try {
                await this.db.insert(schema.labels).values({
                    id: labelId,
                    name: label.name.trim(),
                    nameKey: normalizeLabelName(label.name),
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

    public async updateLabel(id: string, label: Omit<Label, 'id'>) {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            const before = this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();

            try {
                await this.db
                    .update(schema.labels)
                    .set({
                        name: label.name.trim(),
                        nameKey: normalizeLabelName(label.name),
                        color: label.color,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(eq(schema.labels.id, id));
            } catch (e) {
                rethrowDuplicateLabelName(e);
            }

            // Only a display-name change touches cards — the color never appears in a vCard. The old name is
            // matched case-insensitively (CATEGORIES may carry a different case than the label's stored name).
            const newName = label.name.trim();
            if (before && before.name !== newName) {
                const oldNameKey = before.nameKey;
                try {
                    await this.rewriteLabelInMemberCards(id, (names) =>
                        names.map((n) => (normalizeLabelName(n) === oldNameKey ? newName : n)),
                    );
                } catch (forwardError) {
                    try {
                        await this.db
                            .update(schema.labels)
                            .set({
                                name: before.name,
                                nameKey: before.nameKey,
                                color: before.color,
                                updatedAt: before.updatedAt,
                            })
                            .where(eq(schema.labels.id, id));
                        const newNameKey = normalizeLabelName(newName);
                        await this.rewriteLabelInMemberCards(id, (names) =>
                            names.map((n) => (normalizeLabelName(n) === newNameKey ? before.name : n)),
                        );
                    } catch (rollbackError) {
                        console.error(`contacts: failed to compensate label rename ${id}:`, rollbackError);
                    }
                    throw forwardError;
                }
            }

            const updatedLabel = this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
            this.emitLabel(SSEventType.LABEL_UPDATED, id);
            return updatedLabel;
        });
    }

    public async deleteLabel(id: string) {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            const label = this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
            if (label) {
                const { nameKey } = label;
                await this.rewriteLabelInMemberCards(id, (names) =>
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
        const data = row.data ?? {};

        return {
            id: row.id,
            firstName: row.firstName.trim(),
            lastName: row.lastName.trim(),
            eigenId: row.eigenId,
            etag: row.etag,
            ...(data as Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>),
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

    public async uploadAvatar(file: File) {
        this.cleanupAvatarImages().catch(() => {});

        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', AVATAR_PREVIEW);

        if (!result) {
            throw new ApiError(400, 'Failed to generate avatar thumbnail');
        }

        const fileName = `${randomUUID()}.webp`;
        await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${fileName}`, result.data);
        this.avatarsBytes += result.data.byteLength;

        return avatarUrl(this.home.user.id, fileName);
    }

    public async downloadAvatar(filename: string) {
        if (/[/\\]/.test(filename) || filename.includes('..')) {
            return null;
        }
        const file = this.storage.file(`${PATHS.CONTACTS.AVATARS}/${filename}`);
        if (!(await file.exists())) {
            return null;
        }
        return file.arrayBuffer();
    }

    // A staged avatar (uploadAvatar's webp) transcoded to the JPEG we embed as the canonical PHOTO — Apple
    // Contacts can't decode webp contact photos (its list is JPEG/BMP/PNG/GIF), and a 512px q80 JPEG stays
    // under Apple's 224 KB per-photo ceiling so cards survive iCloud round-trips. Null for an empty url; a
    // non-empty url that resolves to nothing (the staged file was swept, a torn transcode) throws so the caller
    // re-uploads rather than silently dropping a photo the user meant to set.
    private async resolveStagedAvatar(
        stagedUrl: string | undefined,
    ): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
        if (!stagedUrl) return null;
        const data = await this.downloadAvatar(stagedUrl.split('/').pop()!);
        const result =
            data &&
            (await generateImagePreview(Buffer.from(data), 'image/webp', 'avatar', '', 'avatar', {
                ...AVATAR_PREVIEW,
                format: 'jpeg',
            }));
        if (!result) throw new ApiError(400, 'Avatar upload could not be found — please upload it again');
        return { bytes: result.data, mediaType: 'image/jpeg' };
    }

    // Derive the webp avatar cache from an inline PHOTO and return its projection URL. Naming by the embedded
    // bytes' hash makes a superseded photo's file fall out of reference, so cleanupAvatarImages sweeps it. A
    // uri-kind or absent photo caches nothing — remote URIs are never fetched (SSRF, spec Non-goals).
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
        await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${name}`, result.data);
        this.avatarsBytes += result.data.byteLength;
        return avatarUrl(this.home.user.id, name);
    }

    private async cleanupAvatarImages() {
        await this.storage.mkdir(PATHS.CONTACTS.AVATARS);
        const files = await this.storage.list(PATHS.CONTACTS.AVATARS);

        // Build the referenced-filename set once, then sweep — O(avatars + contacts), not O(avatars × contacts).
        const referenced = new Set<string>();
        for (const c of await this.getContacts()) {
            if (c.avatar) referenced.add(c.avatar.split('/').pop()!);
        }

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

    private async addYourself() {
        const user = this.home.user;
        const nameParts = (user.name || '').split(' ');
        return await this.addContact({
            eigenId: user.id,
            firstName: nameParts[0] || '',
            lastName: [...nameParts.slice(1)].join(' ') || '',
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

    public async getMe() {
        await this.ensureDrained();
        const found = this.selfRow();
        if (found) {
            return this.getContactById(found.id);
        }
        const addedId = await this.addYourself();
        return this.getContactById(addedId);
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
