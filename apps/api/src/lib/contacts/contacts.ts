import { randomUUID } from 'node:crypto';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
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

function extractContactData(contact: Omit<Contact, 'id'>) {
    const { labels, ...contactData } = contact;
    return {
        data: {
            email: contactData.email,
            phone: contactData.phone,
            company: contactData.company,
            jobTitle: contactData.jobTitle,
            address: contactData.address,
            birthday: contactData.birthday,
            notes: contactData.notes,
            avatar: contactData.avatar,
        },
        contactData,
        labels,
    };
}

export class Contacts {
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;
    private storage: LocalFilesystem;

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

        const existingLabels = await this.db.select().from(schema.labels).all();
        if (existingLabels.length === 0) {
            for (const label of DEFAULT_LABELS) {
                await this.db.insert(schema.labels).values({
                    id: randomUUID(),
                    name: label.name,
                    nameKey: label.name.trim().toLowerCase(),
                    color: label.color,
                });
            }
        }

        if (!(await this.getContacts()).length) {
            const user = this.home.user;
            await this.addYourself();
            const settings = getServerSettings();
            if (settings.onboarding.autoAddOwnerContact) {
                const owner = await getOrgOwner();
                if (owner && owner.id !== user.id) {
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
        }

        this.cleanupAvatarImages().catch(() => {});
    }

    public async size(): Promise<number> {
        let total = 0;
        const files = await this.storage.list('avatars');
        for (const file of files) {
            const size = await this.storage.size(`avatars/${file}`);
            if (size) total += size;
        }
        return total;
    }

    private async setContactLabels(contactId: string, labels: string[]) {
        this.db.transaction((tx) => {
            tx.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, contactId)).run();
            for (const labelId of labels) {
                tx.insert(schema.contactsToLabels)
                    .values({
                        contactId,
                        labelId,
                    })
                    .run();
            }
        });
    }

    public async addContact(contact: Omit<Contact, 'id'>) {
        const contactId = randomUUID();
        const { data, contactData, labels } = extractContactData(contact);

        // Placeholder file-sync fields — filled from the card bytes once the file-backed refit
        // writes the vCard; the DB-only path here has no file to derive them from yet.
        const uri = `${contactId}.vcf`;
        await this.db.insert(schema.contacts).values({
            id: contactId,
            uri,
            uriKey: uri.toLowerCase(),
            uid: contactId,
            firstName: contactData.firstName.trim(),
            lastName: contactData.lastName.trim(),
            eigenId: contactData.eigenId || '',
            isGroup: false,
            data,
            etag: '',
            cardCtag: 0,
            mtime: 0,
            size: 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });

        await this.setContactLabels(contactId, labels || []);

        this.emitContact(SSEventType.CONTACT_CREATED, contactId);

        return contactId;
    }

    public async deleteContact(id: string) {
        if (await this.you(id)) {
            throw new ApiError(400, 'You cannot delete yourself');
        } else {
            await this.db.delete(schema.contacts).where(eq(schema.contacts.id, id));
            this.emitContact(SSEventType.CONTACT_DELETED, id);
        }
    }

    public async updateContact(id: string, contact: Omit<Contact, 'id'>) {
        if (await this.you(id)) {
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

        const { data, contactData, labels } = extractContactData(contact);

        await this.db
            .update(schema.contacts)
            .set({
                firstName: contactData.firstName.trim(),
                lastName: contactData.lastName.trim(),
                data,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.contacts.id, id));

        if (labels !== undefined) {
            await this.setContactLabels(id, labels || []);
        }

        this.emitContact(SSEventType.CONTACT_UPDATED, id);
    }

    public async getLabels(): Promise<Label[]> {
        return this.db.select().from(schema.labels).all();
    }

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
        const labelId = randomUUID();

        await this.db.insert(schema.labels).values({
            id: labelId,
            name: label.name.trim(),
            nameKey: label.name.trim().toLowerCase(),
            color: label.color,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });

        this.emitLabel(SSEventType.LABEL_CREATED, labelId);

        return labelId;
    }

    public async updateLabel(id: string, label: Omit<Label, 'id'>) {
        await this.db
            .update(schema.labels)
            .set({
                name: label.name.trim(),
                nameKey: label.name.trim().toLowerCase(),
                color: label.color,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.labels.id, id));

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
        const row = await this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
        if (!row) return null;
        const labels = this.db
            .select({ labelId: schema.contactsToLabels.labelId })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.contactId, row.id))
            .all()
            .map((rel) => rel.labelId);
        return this.dbRowToContact(row, labels);
    }

    public async getContacts(): Promise<Contact[]> {
        const rows = await this.db.select().from(schema.contacts).all();

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

    private async you(id: string) {
        const maybeYou = await this.getContactById(id);
        return maybeYou?.eigenId === this.home.user.id;
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
        const user = this.home.user;
        const found = this.db.select().from(schema.contacts).where(eq(schema.contacts.eigenId, user.id)).get();
        if (found) {
            return this.getContactById(found.id);
        } else {
            const addedId = await this.addYourself();
            return this.getContactById(addedId);
        }
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
