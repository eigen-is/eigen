import { randomUUID } from 'node:crypto';
import type { Address, Contact, CreateContactInput } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import { enforceHomeDataQuota } from '../config/enforcement';
import { getServerSettings } from '../config/server-settings';
import type { ManagedDatabase, PutResourceResult, ResourcePreconditions } from '../core';
import {
    ApiError,
    BroadcastBatch,
    computeResourceEtag,
    DEFAULT_LABELS,
    LocalFilesystem,
    newSyncGen,
    PATHS,
} from '../core';
import type { Home } from '../home';
import { atHome } from '../home';
import { pushUserProfile } from '../home/home-relay';
import { getOrgOwner } from '../user/';
import { createVCard, mergeVCard, normalizeBirthday, parseVCard } from '../vcard';
import type { CardEdits } from '../vcard/types';
import type { StagedAvatarPair } from './avatars';
import * as avatars from './avatars';
import type { CardProjection, CardRowInput, PurgedCard, Tx } from './card-store';
import {
    avatarNameOf,
    CARD_MAX_BYTES,
    CONTACT_ROW,
    cardBytes,
    indexCard,
    isCardPhotoCacheOf,
    normalizeLabelName,
    PURGED_CARD,
    prepareCard,
    syncCardLabels,
} from './card-store';
import type { CardBook, CardRow, DeleteCardResult } from './dav-store';
import * as davStore from './dav-store';
import { CONTACTS_DB_CONFIG } from './db-config';
import * as labels from './labels';
import { dbRowToContact, toData } from './mappers';
import * as schema from './schema';
import { buildContactEvent, buildContactsChangedEvent, buildLabelEvent } from './sse-events';
import * as transfer from './transfer';

function isBlankAddress(a: Address): boolean {
    return (
        !(a.street ?? '').trim() &&
        !(a.city ?? '').trim() &&
        !(a.state ?? '').trim() &&
        !(a.zipCode ?? '').trim() &&
        !(a.country ?? '').trim()
    );
}

// A bare-date birthday keeps createVCard and toData in agreement, and the form's blank rows would reach DAV clients as empty EMAIL:/TEL:/ADR: lines.
function normalizeContactInput(contact: CreateContactInput): void {
    contact.birthday = normalizeBirthday(contact.birthday ?? '');
    contact.email = contact.email.filter((e) => e.trim() !== '');
    contact.phone = contact.phone.filter((p) => p.trim() !== '');
    contact.address = (contact.address ?? []).filter((a) => !isBlankAddress(a));
}

export class Contacts {
    private managedDb!: ManagedDatabase<typeof schema>;
    db!: BunSQLiteDatabase<typeof schema>;
    home: Home;
    storage: LocalFilesystem;

    // bun:sqlite makes a transaction atomic and serial by itself, but a write path holds async gaps between
    // its check and its commit (the quota check, the avatar derivation), and a racing If-Match PUT must lose
    // inside the lock, not after it.
    writeLock = new Semaphore(1);

    // Running totals so size() answers from memory: a SUM per metered write makes an N-card device sync O(N²).
    // Each delta is read inside the transaction that moves it and applied after: a rollback would otherwise leave it applied.
    cardsBytes = 0;
    avatarsBytes = 0;

    // Whether card writes are quota-metered — see the assignment in init() for what turns it on.
    private meteredIngest = false;

    // Bulk writes in flight; while any runs, per-card events are held and the last one out closes them.
    private readonly batch = new BroadcastBatch(() => this.home.broadcast(buildContactsChangedEvent()));

    constructor(home: Home) {
        this.home = home;
        this.storage = new LocalFilesystem(`${home.homeDir}/${PATHS.CONTACTS.ROOT}`);
    }

    public async init(): Promise<void> {
        this.managedDb = await this.home.getLocalDatabase(CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB);
        this.db = this.managedDb.db;

        this.db.insert(schema.book).values({ id: 1, syncGen: newSyncGen() }).onConflictDoNothing().run();

        // Seeded once here, then moved by delta at each commit and purge.
        this.cardsBytes = this.db
            .select({ total: sql<number>`COALESCE(SUM(${cardBytes}), 0)` })
            .from(schema.contacts)
            .get()!.total;
        this.avatarsBytes = await this.storage.dirSize(PATHS.CONTACTS.AVATARS);

        // Each seed is guarded independently, so a crash between them doesn't skip a later one forever.
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
                // Latched only once a real owner exists, so a deliberate delete stays deleted while a later-configured owner still seeds once.
                this.db.update(schema.book).set({ ownerSeeded: 1 }).where(eq(schema.book.id, 1)).run();
            }
        }

        // Metering starts only here: the quota lookup opens the Home, which during init would await this very init.
        this.meteredIngest = atHome(this.home.user.id);

        this.cleanupAvatarImages().catch((e) => console.warn(`contacts: avatar sweep failed: ${e}`));
    }

    public async size(): Promise<number> {
        return this.cardsBytes + this.avatarsBytes;
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    // --- Seams used by contacts/*.ts ---

    announce(type: Parameters<typeof buildContactEvent>[0], contactId: string): void {
        if (this.batch.hold()) return;
        this.home.broadcast(buildContactEvent(type, contactId));
    }

    // A card written by something else inside the window loses nothing: its invalidation is owner-wide too.
    async withBatchedEvents<T>(fn: () => Promise<T>): Promise<T> {
        return this.batch.run(fn);
    }

    emitLabel(type: Parameters<typeof buildLabelEvent>[0], labelId: string): void {
        this.home.broadcast(buildLabelEvent(type, labelId));
    }

    bumpCtag(tx: Tx): number {
        tx.update(schema.book)
            .set({ ctag: sql`${schema.book.ctag} + 1` })
            .where(eq(schema.book.id, 1))
            .run();
        return tx.select({ ctag: schema.book.ctag }).from(schema.book).where(eq(schema.book.id, 1)).get()!.ctag;
    }

    tombstone(tx: Tx, uri: string, ctag: number): void {
        tx.insert(schema.contactTombstones)
            .values({ uri, deletedAtCtag: ctag })
            .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
            .run();
    }

    // One transaction, so the ctag bump, the blob, the label junction and the tombstone clear settle together.
    private commitCard(opts: { row: CardRowInput; categories: string[] }): void {
        const { delta, createdLabelIds } = this.db.transaction((tx) => {
            const previous = tx
                .select({ size: cardBytes })
                .from(schema.contacts)
                .where(eq(schema.contacts.id, opts.row.id))
                .get();
            return {
                delta: opts.row.vcard.byteLength - (previous?.size ?? 0),
                createdLabelIds: indexCard(tx, opts.row, opts.categories, this.bumpCtag(tx)),
            };
        });
        this.cardsBytes += delta;

        for (const id of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, id);
    }

    // The one write every card path takes, and it owns the order: both ceilings judge the bytes before `cache`
    // derives the avatar and before the transaction that stores them, so a refusal leaves neither a row nor a
    // webp behind. `creditBytes` is the stored card this one replaces, or a rewrite that shrinks a card would
    // be refused on a quota its own bytes already hold. Returns the avatar URL the projection stored.
    async writeCard(opts: {
        row: CardProjection & Pick<CardRowInput, 'id' | 'uri' | 'eigenId'>;
        categories: string[];
        creditBytes: number;
        cache: () => Promise<string>;
    }): Promise<string> {
        if (opts.row.vcard.byteLength > CARD_MAX_BYTES) {
            throw new ApiError(413, 'Contact card is too large');
        }
        if (this.meteredIngest) {
            await enforceHomeDataQuota(this.home.user.id, opts.row.vcard.byteLength, opts.creditBytes);
        }
        const avatar = await opts.cache();
        this.commitCard({ row: { ...opts.row, data: { ...opts.row.data, avatar } }, categories: opts.categories });
        return avatar;
    }

    // Callers hold the write lock, have run their own guards, and announce the deletion once they let go of it.
    async purgeCard(row: PurgedCard): Promise<void> {
        const removed = this.db.transaction((tx) => {
            const size = tx
                .select({ size: cardBytes })
                .from(schema.contacts)
                .where(eq(schema.contacts.id, row.id))
                .get()!.size;
            const ctag = this.bumpCtag(tx);
            tx.delete(schema.contacts).where(eq(schema.contacts.id, row.id)).run();
            this.tombstone(tx, row.uri, ctag);
            return size;
        });

        this.cardsBytes -= removed;
        const avatarName = row.data?.avatar ? avatarNameOf(row.data.avatar) : undefined;
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
    }

    // --- Contacts ---

    // The blob is the truth, so every projected column and the junction come back from it. Untouched, because no
    // blob carries them: the self-link, the ctags, the tombstones, and each label's id and color.
    public rebuildProjection(): void {
        const rows = this.db
            .select({
                id: schema.contacts.id,
                uid: schema.contacts.uid,
                vcard: schema.contacts.vcard,
                data: schema.contacts.data,
            })
            .from(schema.contacts)
            .all();
        const createdLabelIds = this.db.transaction((tx) => {
            const created: string[] = [];
            for (const row of rows) {
                const parsed = parseVCard(new TextDecoder().decode(row.vcard));
                // The avatar cache is derived asynchronously from the PHOTO, so the stored URL is carried over,
                // and the blob the rest is rebuilt from is left alone rather than rewritten to its own value.
                const { vcard: _bytes, ...projection } = prepareCard(
                    row.vcard,
                    parsed,
                    row.data?.avatar ?? '',
                    row.uid,
                );
                tx.update(schema.contacts).set(projection).where(eq(schema.contacts.id, row.id)).run();
                created.push(...syncCardLabels(tx, row.id, parsed.categories));
            }
            return created;
        });

        for (const id of createdLabelIds) this.emitLabel(SSEventType.LABEL_CREATED, id);
    }

    // At most one row may carry eigenId = user.id; the X-EIGEN-ID stays in the stored bytes regardless.
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
        return labels.labelNamesFor(this, labelIds);
    }

    public async addContact(contact: CreateContactInput): Promise<string> {
        return this.writeLock.run(async () => {
            normalizeContactInput(contact);

            const id = randomUUID();
            const uri = `${id}.vcf`;
            const categories = this.labelNamesFor(contact.labels ?? []);
            // Throws when a staged avatar was swept: a create with a vanished upload must fail, not drop the photo silently.
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

            await this.writeCard({
                creditBytes: 0,
                row: {
                    id,
                    uri,
                    uid: id,
                    vcard: Buffer.from(bytes),
                    firstName: contact.firstName.trim(),
                    lastName: contact.lastName.trim(),
                    eigenId: this.resolveSelfLink(contact.eigenId),
                    isGroup: false,
                    data: toData(contact),
                    etag: computeResourceEtag(bytes),
                },
                categories,
                // The projection stores the promoted webp's hashed URL, or '' when there is no photo.
                cache: async () => (staged ? this.promoteAvatarCache(id, staged) : ''),
            });

            this.announce(SSEventType.CONTACT_CREATED, id);
            return id;
        });
    }

    public async updateContact(id: string, contact: CreateContactInput, expectedEtag?: string): Promise<void> {
        return this.writeLock.run(async () => {
            // Runs before the self-card own-email prepend below, so that email can't be dropped as a blank.
            normalizeContactInput(contact);

            const row = this.db
                .select({
                    uri: schema.contacts.uri,
                    uid: schema.contacts.uid,
                    vcard: schema.contacts.vcard,
                    eigenId: schema.contacts.eigenId,
                    isGroup: schema.contacts.isGroup,
                    data: schema.contacts.data,
                    etag: schema.contacts.etag,
                })
                .from(schema.contacts)
                .where(eq(schema.contacts.id, id))
                .get();
            if (!row) throw new ApiError(404, 'Contact not found');
            if (expectedEtag !== undefined && expectedEtag !== row.etag) {
                throw new ApiError(412, 'Contact was changed elsewhere');
            }

            // A self-card edit renames the user org-wide, so its inputs are read before the write swaps the staged URL and pushed after the commit.
            const isSelf = row.eigenId === this.home.user.id;
            const selfName = `${contact.firstName} ${contact.lastName}`;
            let selfAvatarBuffer: Buffer | null = null;
            if (isSelf) {
                if (contact.avatar) {
                    const data = await this.downloadAvatar(avatarNameOf(contact.avatar));
                    if (data) selfAvatarBuffer = Buffer.from(data);
                }
                if (!contact.email.includes(this.home.user.email)) {
                    contact.email = [this.home.user.email, ...contact.email];
                }
            }

            const card = parseVCard(new TextDecoder().decode(row.vcard));
            const categories = this.labelNamesFor(contact.labels ?? []);
            // REST is a full replacement and the merge is value-keyed, so unchanged values keep their bytes; X-EIGEN-ID is not REST-owned.
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
            // PHOTO is touched only when the avatar changed against the stored row: a silent strip would lose a photo the user meant to replace.
            const avatarChanged = contact.avatar !== (row.data?.avatar ?? '');
            let staged: StagedAvatarPair | null = null;
            if (avatarChanged) {
                if (contact.avatar) {
                    staged = await this.resolveStagedAvatar(contact.avatar);
                }
                edits.photo = staged?.embed ?? null;
            }

            const bytes = new TextEncoder().encode(mergeVCard(card, edits));

            await this.writeCard({
                creditBytes: row.vcard.byteLength,
                row: {
                    id,
                    uri: row.uri,
                    uid: row.uid,
                    vcard: Buffer.from(bytes),
                    firstName: contact.firstName.trim(),
                    lastName: contact.lastName.trim(),
                    eigenId: row.eigenId,
                    isGroup: row.isGroup,
                    data: toData(contact),
                    etag: computeResourceEtag(bytes),
                },
                categories,
                // An unchanged photo keeps the stored URL; a changed one promotes the staged webp, or clears it.
                cache: async () => {
                    if (!avatarChanged) return contact.avatar ?? '';
                    return staged ? this.promoteAvatarCache(id, staged) : '';
                },
            });

            // Propagation is downstream of a settled mutation: reporting its failure hands back a stale etag, so the client's retry 412s on an edit that succeeded.
            if (isSelf) {
                try {
                    await pushUserProfile(this.home.user.id, selfName, selfAvatarBuffer);
                } catch (e) {
                    console.error(`contacts: failed to propagate the profile of ${this.home.user.id}:`, e);
                }
            }
            this.announce(SSEventType.CONTACT_UPDATED, id);
        });
    }

    public async deleteContact(id: string, expectedEtag?: string): Promise<void> {
        const deleted = await this.writeLock.run(async () => {
            const row = this.db.select(PURGED_CARD).from(schema.contacts).where(eq(schema.contacts.id, id)).get();
            // Idempotent, and the etag is not evaluated for a resource that no longer exists.
            if (!row) return null;
            if (row.eigenId === this.home.user.id) {
                throw new ApiError(400, 'You cannot delete yourself');
            }
            if (expectedEtag !== undefined && expectedEtag !== row.etag) {
                throw new ApiError(412, 'Contact was changed elsewhere');
            }

            await this.purgeCard(row);
            return row.id;
        });

        if (deleted) this.announce(SSEventType.CONTACT_DELETED, deleted);
    }

    // --- Label facade — implementation in contacts/labels.ts ---

    public async getLabels(): Promise<Label[]> {
        return labels.getLabels(this);
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

    public async getContactById(id: string): Promise<Contact | null> {
        const row = this.db
            .select({ ...CONTACT_ROW, isGroup: schema.contacts.isGroup })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, id))
            .get();
        if (!row || row.isGroup) return null;
        const labelIds = this.db
            .select({ labelId: schema.contactsToLabels.labelId })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.contactId, row.id))
            .all()
            .map((rel) => rel.labelId);
        return dbRowToContact(row, labelIds);
    }

    public async getContacts(): Promise<Contact[]> {
        // Groups are DAV-only aggregates; the app's contact list never shows them.
        const rows = this.db.select(CONTACT_ROW).from(schema.contacts).where(eq(schema.contacts.isGroup, false)).all();

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

        return rows.map((row) => dbRowToContact(row, labelsByContact.get(row.id) ?? []));
    }

    // --- Avatar facade — implementation in contacts/avatars.ts ---

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

    private cleanupAvatarImages(): Promise<void> {
        return avatars.cleanupAvatarImages(this);
    }

    private selfRow() {
        return this.db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.eigenId, this.home.user.id))
            .get();
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
        const found = this.selfRow();
        if (found) {
            return this.getContactById(found.id);
        }
        const addedId = await this.addYourself();
        return this.getContactById(addedId);
    }

    // --- CardDAV store facade — implementation in contacts/dav-store.ts ---

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

    public async putCard(uri: string, body: string, options: ResourcePreconditions): Promise<PutResourceResult> {
        const result = await davStore.putCard(this, uri, body, options);
        // Told once the write lock is released, from the id the write read inside it: a re-read could lose a racing delete.
        if (result.ok) {
            this.announce(result.created ? SSEventType.CONTACT_CREATED : SSEventType.CONTACT_UPDATED, result.id);
        }
        return result;
    }

    public async deleteCard(uri: string, pre: Pick<ResourcePreconditions, 'ifMatch'>): Promise<DeleteCardResult> {
        const result = await davStore.deleteCard(this, uri, pre);
        // Told once the write lock is released, the way a PUT is.
        if (result.ok) this.announce(SSEventType.CONTACT_DELETED, result.id);
        return result;
    }

    // --- vCard transfer facade — implementation in contacts/transfer.ts ---

    public async exportCards(ids?: string[]): Promise<string> {
        return transfer.exportCards(this, ids);
    }

    public async importCards(bytes: Uint8Array): Promise<ImportCountsResult> {
        return transfer.importCards(this, bytes);
    }
}
