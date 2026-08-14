import { randomUUID } from 'node:crypto';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import type { ParsedCardPhoto } from '../carddav/vcard-parse';
import { parseVCard } from '../carddav/vcard-parse';
import { type CardEdits, createVCard, mergeVCard } from '../carddav/vcard-serialize';
import { getServerSettings } from '../config/server-settings';
import { DEFAULT_LABELS, LocalFilesystem, PATHS } from '../core';
import type { ManagedDatabase } from '../core/';
import { ApiError } from '../core/';
import type { Home } from '../home';
import { getHome } from '../home';
import { pushUserProfile } from '../home/home-relay';
import { generateImagePreview } from '../shared/thumbnails';
import type { User } from '../user';
import { getOrgOwner } from '../user/';
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

// The index-stored projection: the owned properties minus what lives in dedicated columns (names/eigenId)
// or the junction (labels). `avatar` is the cache URL only — inline photo bytes never enter the index.
function toData(contact: Omit<Contact, 'id'>): (typeof schema.contacts.$inferInsert)['data'] {
    return {
        email: contact.email,
        phone: contact.phone,
        company: contact.company,
        jobTitle: contact.jobTitle,
        address: contact.address,
        birthday: contact.birthday,
        notes: contact.notes,
        avatar: contact.avatar,
    };
}

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

        await cleanupTempCardFiles(this.storage);

        // Seed size totals from disk once; every card write/delete adjusts them by delta thereafter.
        this.cardsBytes = await this.storage.dirSize(CARDS_DIR);
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
        if (settings.onboarding.autoAddOwnerContact) {
            const owner = await getOrgOwner();
            if (owner && owner.id !== this.home.user.id && !this.hasContactWithEmail(owner.email)) {
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
        }

        this.cleanupAvatarImages().catch(() => {});
    }

    public async size(): Promise<number> {
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
                tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uri, opts.row.uri)).run();
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
            const file = this.storage.file(cardPath(uri));
            if (await file.exists()) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const stat = await this.storage.stat(cardPath(uri));
                const parsed = this.parseCardFile(bytes);
                this.commitCard({
                    row: {
                        id: existing?.id ?? randomUUID(),
                        uri,
                        uriKey: uriKeyOf(uri),
                        uid: parsed.uid ?? existing?.uid ?? randomUUID(),
                        firstName: parsed.firstName.trim(),
                        lastName: parsed.lastName.trim(),
                        eigenId: existing?.eigenId ?? '',
                        isGroup: parsed.isGroup,
                        data: {
                            email: parsed.email,
                            phone: parsed.phone,
                            company: parsed.company,
                            jobTitle: parsed.jobTitle,
                            address: parsed.address,
                            birthday: parsed.birthday,
                            notes: parsed.notes,
                            avatar: existing?.data?.avatar,
                        },
                        etag: computeCardEtag(bytes),
                        mtime: Math.round(stat.mtimeMs),
                        size: stat.size,
                    },
                    categories: parsed.categories,
                });
                this.cardsBytes += stat.size - (existing?.size ?? 0);
            } else if (existing) {
                this.db.transaction((tx) => {
                    const ctag = this.bumpCtag(tx);
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, existing.id)).run();
                    tx.insert(schema.contactTombstones)
                        .values({ uri, deletedAtCtag: ctag })
                        .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
                        .run();
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

    // Read one card file into the index row + label names to (re)commit for it, running the eigenId rematch
    // (§ 2 — a card carrying this user's id, or the owner's email with the X-EIGEN-ID stripped, claims the single
    // self-link slot via `claimSelf`; an email-only match rewrites the property back into the file) and
    // regenerating a missing inline-photo cache (Task 10 seam). `id` is the stable contact id (an existing row's
    // or a fresh one), `existingUid` the uid fallback for a card with none.
    private async prepareCardRow(
        uri: string,
        id: string,
        existingUid: string | undefined,
        claimSelf: () => boolean,
    ): Promise<{ row: CardRowInput; categories: string[] }> {
        let bytes = new Uint8Array(await this.storage.file(cardPath(uri)).arrayBuffer());
        const parsed = this.parseCardFile(bytes);

        const ownerEmail = this.home.user.email.toLowerCase();
        const wantsSelf =
            parsed.eigenId === this.home.user.id ||
            (!parsed.eigenId && parsed.email.some((e) => e.toLowerCase() === ownerEmail));
        let eigenId = '';
        if (wantsSelf && claimSelf()) {
            eigenId = this.home.user.id;
            // An email-only rematch restores the stripped link into the file; a card already carrying the id
            // keeps its exact bytes.
            if (!parsed.eigenId) {
                bytes = new TextEncoder().encode(mergeVCard(parsed, { eigenId: this.home.user.id }));
                await writeCardFile(this.storage, uri, bytes);
            }
        }

        // The projection avatar is the derived cache URL; regenerate it only when the file has an inline photo
        // whose hashed cache file is missing (out-of-band drift / a rebuild after a cache wipe).
        let avatar = '';
        if (parsed.photo?.kind === 'inline') {
            const cacheName = `${id}-${computeCardEtag(parsed.photo.bytes).slice(0, 8)}.webp`;
            avatar = `contacts/${this.home.user.id}/avatar/${cacheName}`;
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
                    avatar,
                },
                etag: computeCardEtag(bytes),
                mtime: Math.round(stat.mtimeMs),
                size: stat.size,
            },
            categories: parsed.categories,
        };
    }

    // Stat-only reconcile: list cards/, compare (mtime,size) to the index, and re-read only what drifted — the
    // clean case (always, in practice) is one listing plus stats, zero file reads. New/drifted cards are
    // re-indexed and vanished rows tombstoned under a single ctag bump; a fully clean pass parses nothing and
    // bumps nothing (spec § 1). A same-size, timestamp-preserving replacement is invisible here — that needs
    // `rebuildIndex`.
    public async reconcileIndex(): Promise<void> {
        return this.writeLock.run(async () => {
            const present = new Map<string, { uri: string; mtime: number; size: number }>();
            for (const name of await this.storage.list(CARDS_DIR)) {
                const uri = sanitizeCardUri(name);
                if (!uri) continue; // a non-conforming leftover cleanupTempCardFiles missed — never trust the name
                const stat = await this.storage.stat(cardPath(uri));
                present.set(uriKeyOf(uri), { uri, mtime: Math.round(stat.mtimeMs), size: stat.size });
            }

            const rows = this.db.select().from(schema.contacts).all();
            const rowByKey = new Map(rows.map((r) => [r.uriKey, r] as const));

            const reindex: { uri: string; existing?: (typeof rows)[number] }[] = [];
            for (const [key, info] of present) {
                const existing = rowByKey.get(key);
                if (!existing || info.mtime !== existing.mtime || info.size !== existing.size) {
                    reindex.push({ uri: info.uri, existing });
                }
            }
            const vanished = rows.filter((r) => !present.has(r.uriKey));

            if (reindex.length === 0 && vanished.length === 0) return; // clean pass: zero parses, zero bump

            reindex.sort((a, b) => (a.uri < b.uri ? -1 : 1)); // stable order for the self-link tie-break

            // One self-link slot: a surviving self row this pass is NOT re-indexing already holds it.
            const reindexKeys = new Set(reindex.map((r) => uriKeyOf(r.uri)));
            let selfClaimed = rows.some((r) => r.eigenId === this.home.user.id && !reindexKeys.has(r.uriKey));
            const claimSelf = () => {
                if (selfClaimed) return false;
                selfClaimed = true;
                return true;
            };

            const prepared: { row: CardRowInput; categories: string[]; isNew: boolean }[] = [];
            for (const { uri, existing } of reindex) {
                const { row, categories } = await this.prepareCardRow(
                    uri,
                    existing?.id ?? randomUUID(),
                    existing?.uid,
                    claimSelf,
                );
                prepared.push({ row, categories, isNew: !existing });
            }

            const createdLabelIds: string[] = [];
            this.db.transaction((tx) => {
                const ctag = this.bumpCtag(tx);
                for (const { row } of prepared) {
                    tx.insert(schema.contacts)
                        .values({ ...row, cardCtag: ctag })
                        .onConflictDoUpdate({
                            target: schema.contacts.id,
                            set: {
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
                }
                for (const { row, categories } of prepared)
                    this.syncCardLabels(tx, row.id, categories, createdLabelIds);
                for (const r of vanished) {
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, r.id)).run();
                    tx.insert(schema.contactTombstones)
                        .values({ uri: r.uri, deletedAtCtag: ctag })
                        .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
                        .run();
                }
            });

            // cardsBytes is authoritative from the pass's final sizes (post-rewrite for any rematched card).
            const finalSize = new Map<string, number>();
            for (const [key, info] of present) finalSize.set(key, info.size);
            for (const { row } of prepared) finalSize.set(row.uriKey, row.size);
            this.cardsBytes = [...finalSize.values()].reduce((sum, v) => sum + v, 0);

            for (const labelId of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, labelId);
            for (const { row, isNew } of prepared) {
                this.emitContact(isNew ? SSEventType.CONTACT_CREATED : SSEventType.CONTACT_UPDATED, row.id);
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
            const existingByKey = new Map(
                this.db
                    .select()
                    .from(schema.contacts)
                    .all()
                    .map((r) => [r.uriKey, r] as const),
            );
            const book = this.indexIsIntact()
                ? this.db.select().from(schema.book).where(eq(schema.book.id, 1)).get()
                : undefined;
            const newCtag = Math.max(book?.ctag ?? 0, 0) + 1;
            const newSyncGen = (book?.syncGen ?? 1) + 1;

            const names: string[] = [];
            for (const name of await this.storage.list(CARDS_DIR)) {
                const uri = sanitizeCardUri(name);
                if (uri) names.push(uri);
            }
            names.sort(); // stable order for the self-link tie-break

            let selfClaimed = false;
            const claimSelf = () => {
                if (selfClaimed) return false;
                selfClaimed = true;
                return true;
            };

            const prepared: { row: CardRowInput; categories: string[] }[] = [];
            for (const uri of names) {
                const existing = existingByKey.get(uriKeyOf(uri));
                const { row, categories } = await this.prepareCardRow(
                    uri,
                    existing?.id ?? randomUUID(),
                    existing?.uid,
                    claimSelf,
                );
                prepared.push({ row, categories });
            }

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

            const id = randomUUID();
            const uri = `${id}.vcf`;
            const categories = this.labelNamesFor(contact.labels ?? []);
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

            const { mtime, size } = await writeCardFile(this.storage, uri, bytes);
            // The avatar cache is derived from the embed; the projection stores its hashed URL (or '' if none).
            contact.avatar = await this.cacheCardPhoto(
                id,
                photo ? { kind: 'inline', bytes: photo.bytes, mediaType: photo.mediaType } : null,
            );
            try {
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
            } catch (e) {
                this.markCardDirty(uri);
                throw e;
            }

            this.cardsBytes += size;
            this.emitContact(SSEventType.CONTACT_CREATED, id);
            return id;
        });
    }

    public async updateContact(id: string, contact: Omit<Contact, 'id'>, expectedEtag?: string): Promise<void> {
        return this.writeLock.run(async () => {
            await this.drainDirty();

            const row = this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
            if (!row) throw new ApiError(404, 'Contact not found');
            if (expectedEtag !== undefined && expectedEtag !== row.etag) {
                throw new ApiError(412, 'Contact was changed elsewhere');
            }

            if (row.eigenId === this.home.user.id) {
                const name = `${contact.firstName} ${contact.lastName}`;
                let avatarBuffer: Buffer | null = null;
                if (contact.avatar) {
                    const filename = contact.avatar.split('/').pop()!;
                    const data = await this.downloadAvatar(filename);
                    if (data) avatarBuffer = Buffer.from(data);
                }
                await pushUserProfile(this.home.user.id, name, avatarBuffer);

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
            // avatar resolves the staged webp to an embedded JPEG; an explicit clear (avatar === '') removes
            // PHOTO. The derived cache + projection URL are rebuilt from the embed after the write.
            const avatarChanged = contact.avatar !== (row.data?.avatar ?? '');
            let photo: { bytes: Uint8Array; mediaType: string } | null = null;
            if (avatarChanged) {
                if (contact.avatar) {
                    photo = await this.resolveStagedAvatar(contact.avatar);
                    // A changed, non-empty avatar whose staged file has vanished (cleanupAvatarImages can sweep a
                    // freshly-staged-but-unsaved file) fails the save — silently stripping the existing PHOTO
                    // would lose a photo the user meant to replace.
                    if (!photo) throw new ApiError(400, 'Avatar upload could not be found — please upload it again');
                }
                edits.photo = photo;
            }

            const bytes = new TextEncoder().encode(mergeVCard(card, edits));

            const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
            if (avatarChanged) {
                contact.avatar = await this.cacheCardPhoto(
                    id,
                    photo ? { kind: 'inline', bytes: photo.bytes, mediaType: photo.mediaType } : null,
                );
            }
            try {
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
            } catch (e) {
                this.markCardDirty(row.uri);
                throw e;
            }

            this.cardsBytes += size - row.size;
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

            await this.storage.delete(cardPath(row.uri));
            // Fail closed if the index step throws after the file is already gone: mark the uri so the next
            // drain's vanished-file branch tombstones it, mirroring the create/update seams.
            try {
                this.db.transaction((tx) => {
                    const ctag = this.bumpCtag(tx);
                    tx.delete(schema.contacts).where(eq(schema.contacts.id, id)).run();
                    tx.insert(schema.contactTombstones)
                        .values({ uri: row.uri, deletedAtCtag: ctag })
                        .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
                        .run();
                });
            } catch (e) {
                this.markCardDirty(row.uri);
                throw e;
            }

            this.cardsBytes -= row.size;
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

            const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
            try {
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
            } catch (e) {
                this.markCardDirty(row.uri);
                throw e;
            }

            this.cardsBytes += size - row.size;
            this.emitContact(SSEventType.CONTACT_UPDATED, row.id);
        }
    }

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
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
                await this.rewriteLabelInMemberCards(id, (names) =>
                    names.map((n) => (normalizeLabelName(n) === oldNameKey ? newName : n)),
                );
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
        const result = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', {
            maxSize: 512,
            quality: 80,
            fit: 'cover',
        });

        if (!result) {
            throw new ApiError(400, 'Failed to generate avatar thumbnail');
        }

        const fileName = `${randomUUID()}.webp`;
        await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${fileName}`, result.data);
        this.avatarsBytes += result.data.byteLength;

        return `contacts/${this.home.user.id}/avatar/${fileName}`;
    }

    public async downloadAvatar(filename: string) {
        if (/[/\\]/.test(filename) || filename.includes('..')) {
            return null;
        }
        const file = this.storage.file(`avatars/${filename}`);
        if (!(await file.exists())) {
            return null;
        }
        return file.arrayBuffer();
    }

    // A staged avatar (uploadAvatar's webp) transcoded to the JPEG we embed as the canonical PHOTO — Apple
    // Contacts can't decode webp contact photos (its list is JPEG/BMP/PNG/GIF), and a 512px q80 JPEG stays
    // under Apple's 224 KB per-photo ceiling so cards survive iCloud round-trips. Null for an empty/missing url.
    private async resolveStagedAvatar(
        avatarUrl: string | undefined,
    ): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
        if (!avatarUrl) return null;
        const data = await this.downloadAvatar(avatarUrl.split('/').pop()!);
        if (!data) return null;
        const result = await generateImagePreview(Buffer.from(data), 'image/webp', 'avatar', '', 'avatar', {
            maxSize: 512,
            quality: 80,
            fit: 'cover',
            format: 'jpeg',
        });
        return result ? { bytes: result.data, mediaType: 'image/jpeg' } : null;
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
            { maxSize: 512, quality: 80, fit: 'cover' },
        );
        if (!result) return '';
        const name = `${contactId}-${computeCardEtag(photo.bytes).slice(0, 8)}.webp`;
        await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${name}`, result.data);
        this.avatarsBytes += result.data.byteLength;
        return `contacts/${this.home.user.id}/avatar/${name}`;
    }

    private async cleanupAvatarImages() {
        await this.storage.mkdir('avatars');
        const files = await this.storage.list('avatars');
        const contacts = await this.getContacts();
        for (const file of files) {
            const contact = contacts.find((c) => c.avatar?.includes(file));
            if (!contact) {
                await this.storage.delete(`avatars/${file}`);
            }
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
