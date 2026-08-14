import { randomUUID } from 'node:crypto';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
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

    // A card whose file wrote but whose index commit threw lands here; the next mutation re-indexes it before
    // it observes the index (fail-closed, spec § 1). Directory-wide reconcile/rebuild is Task 11.
    private dirtyCards = new Set<string>();

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

    // The single index-write seam: one transaction that stamps the fresh ctag, upserts the row, rebuilds the
    // label junction from the card's CATEGORIES (auto-creating labels by nameKey), and clears any tombstone.
    private commitCard(opts: {
        row: Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;
        categories: string[];
        tombstoneCleared?: boolean;
    }): void {
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

            // CATEGORIES is membership truth: each name resolves to a label by nameKey, minting one when absent.
            const labelIds = new Set<string>();
            for (const name of opts.categories) {
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

            tx.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, opts.row.id)).run();
            for (const labelId of labelIds) {
                tx.insert(schema.contactsToLabels).values({ contactId: opts.row.id, labelId }).run();
            }

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
                const parsed = parseVCard(new TextDecoder().decode(bytes));
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
                        photo: undefined, // inline PHOTO embedding lands in Task 10
                    },
                    id,
                ),
            );

            const { mtime, size } = await writeCardFile(this.storage, uri, bytes);
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
            // unchanged values keep their exact bytes. eigenId/photo are omitted — the file's X-EIGEN-ID and
            // PHOTO are not REST-owned here (rematch is Task 11, PHOTO embedding is Task 10).
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
            const bytes = new TextEncoder().encode(mergeVCard(card, edits));

            const { mtime, size } = await writeCardFile(this.storage, row.uri, bytes);
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
            this.db.transaction((tx) => {
                const ctag = this.bumpCtag(tx);
                tx.delete(schema.contacts).where(eq(schema.contacts.id, id)).run();
                tx.insert(schema.contactTombstones)
                    .values({ uri: row.uri, deletedAtCtag: ctag })
                    .onConflictDoUpdate({ target: schema.contactTombstones.uri, set: { deletedAtCtag: ctag } })
                    .run();
            });

            this.cardsBytes -= row.size;
            this.emitContact(SSEventType.CONTACT_DELETED, id);
        });
    }

    public async getLabels(): Promise<Label[]> {
        return this.db.select().from(schema.labels).all();
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

        const updatedLabel = await this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();

        this.emitLabel(SSEventType.LABEL_UPDATED, id);

        return updatedLabel;
    }

    public async deleteLabel(id: string) {
        this.db.transaction((tx) => {
            tx.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.labelId, id)).run();
            tx.delete(schema.labels).where(eq(schema.labels.id, id)).run();
        });
        this.emitLabel(SSEventType.LABEL_DELETED, id);
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
