import type Database from "bun:sqlite";
import type {Contact} from "../../types/contact";
import type {Label} from "../../types/label";
import {BunSQLiteDatabase, drizzle} from "drizzle-orm/bun-sqlite";
import {eq, sql} from "drizzle-orm";
import * as schema from "./schema";
import {v4 as uuidv4} from "uuid";
import {getHome} from "../home/home";
import type {HomeInterface} from "../home/types";
import type {User} from "better-auth/types";
import {getUserByEmail, updateUser} from "../users/users.ts";
import {LocalStorage} from "../storage";
import {generateThumbnail} from "../shared/thumbnails";
import {PATHS, DEFAULT_LABELS} from "../core/constants";

export async function getContacts(user: User) {
    const home = await getHome(user);
    // const contacts = new Contacts(home);
    // await contacts.init();
    // return contacts;
    return home.contacts;
}

async function getContactsDatabase(home: HomeInterface) {
    const db = await home.openSQLiteDatabase('eigen.contacts/contacts.db', async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                firstName TEXT NOT NULL,
                lastName TEXT NOT NULL,
                eigenId TEXT,
                avatar TEXT,
                data TEXT,
                createdAt INTEGER DEFAULT (unixepoch()),
                updatedAt INTEGER DEFAULT (unixepoch())
            );
            
            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                createdAt INTEGER DEFAULT (unixepoch()),
                updatedAt INTEGER DEFAULT (unixepoch())
            );
            
            CREATE TABLE IF NOT EXISTS contacts_to_labels (
                contactId TEXT NOT NULL,
                labelId TEXT NOT NULL,
                PRIMARY KEY (contactId, labelId),
                FOREIGN KEY (contactId) REFERENCES contacts(id) ON DELETE CASCADE,
                FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
            );
        `);


        try {
            const dr = drizzle(db, {schema});
            const existingLabels = await dr.select().from(schema.labels).all();
            if (existingLabels.length === 0) {
                for (const label of DEFAULT_LABELS) {
                    await dr.insert(schema.labels).values({
                        id: uuidv4(),
                        name: label.name,
                        color: label.color
                    });
                }
            }
        } catch (error) {
            console.error('Error setting up default labels:', error);
        }
    });

    return drizzle(db, {schema});
}

function extractContactData(contact: Omit<Contact, 'id'>) {
    const {labels, ...contactData} = contact;
    return {
        data: {
            email: contactData.email,
            phone: contactData.phone,
            company: contactData.company,
            jobTitle: contactData.jobTitle,
            address: contactData.address,
            birthday: contactData.birthday,
            notes: contactData.notes,
            avatar: contactData.avatar
        },
        contactData,
        labels
    };
}

export class Contacts {
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: HomeInterface;
    private storage: LocalStorage;

    constructor(home: HomeInterface) {
        this.home = home;
        this.storage = new LocalStorage(`${home.homeDir}/eigen.contacts`);
    }

    public async init() {
        this.db = await getContactsDatabase(this.home);
        if (!(await this.getContacts()).length) {
            const user = this.home.user;

            // add the user to the contacts table
            await this.addYourself();
            // add reinder, zodat het een beetje gezellig is
            const reinder = await getUserByEmail('reinder@eigen.is');
            if (reinder && reinder.id !== user.id) {
                this.addContact({
                    eigenId: reinder.id,
                    firstName: 'Reinder',
                    lastName: 'Nijhoff',
                    email: [reinder.email],
                    phone: [],
                    company: '',
                    jobTitle: '',
                    address: [],
                    birthday: '',
                    notes: '',
                    avatar: '',
                    labels: []
                });
            }
        }

        this.cleanupAvatarImages();
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

    public async setContactLabels(contactId: string, labels: string[]) {
        // Delete existing labels
        await this.db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, contactId));

        // Insert new labels
        for (const labelId of labels) {
            await this.db.insert(schema.contactsToLabels).values({
                contactId,
                labelId
            });
        }
    }

    public async addContact(contact: Omit<Contact, 'id'>) {
        const contactId = uuidv4();
        const {data, contactData, labels} = extractContactData(contact);

        await this.db.insert(schema.contacts).values({
            id: contactId,
            firstName: contactData.firstName.trim(),
            lastName: contactData.lastName.trim(),
            eigenId: contactData.eigenId || '',
            data,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });

        // Add labels if provided
        await this.setContactLabels(contactId, labels || []);

        return contactId;
    }

    public async deleteContact(id: string) {
        // you can't delete yourself!
        if (await this.you(id)) {
            throw new Error('You cannot delete yourself');
        } else {
            await this.db.delete(schema.contacts).where(eq(schema.contacts.id, id));
        }
    }

    public async updateContact(id: string, contact: Omit<Contact, 'id'>) {
        if (await this.you(id)) {
            updateUser(this.home.user, `${contact.firstName} ${contact.lastName}`, contact.avatar || '');
            // check if this.home.user.email is included in contact.email, add as first element if not
            if (!contact.email.includes(this.home.user.email)) {
                contact.email = [this.home.user.email, ...contact.email];
            }
        }

        const {data, contactData, labels} = extractContactData(contact);

        // Update contact
        await this.db.update(schema.contacts)
            .set({
                firstName: contactData.firstName.trim(),
                lastName: contactData.lastName.trim(),
                data,
                updatedAt: sql`unixepoch()`
            })
            .where(eq(schema.contacts.id, id));

        // Update labels if provided
        await this.setContactLabels(id, labels || []);
    }

    public async getLabels(): Promise<Label[]> {
        return this.db.select().from(schema.labels).all();
    }

    public async addLabel(label: Omit<Label, 'id'>): Promise<string> {
        const labelId = uuidv4();

        await this.db.insert(schema.labels).values({
            id: labelId,
            name: label.name.trim(),
            color: label.color,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });

        return labelId;
    }

    public async updateLabel(id: string, label: Omit<Label, 'id'>) {
        console.log('Updating label:', id, label);

        try {
            await this.db.update(schema.labels)
                .set({
                    name: label.name.trim(),
                    color: label.color,
                    updatedAt: sql`unixepoch()`
                })
                .where(eq(schema.labels.id, id));

            console.log('Label updated successfully');

            // Return the updated label
            const updatedLabel = await this.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
            console.log('Updated label:', updatedLabel);
            return updatedLabel;
        } catch (error) {
            console.error('Error updating label:', error);
            throw error;
        }
    }

    public async deleteLabel(id: string) {
        await this.db.delete(schema.labels).where(eq(schema.labels.id, id));
        await this.db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.labelId, id));
    }

    public async getContactById(id: string): Promise<Contact | null> {
        const contact = await this.db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();

        if (!contact) return null;

        const labelRelations = this.db.select({
            labelId: schema.contactsToLabels.labelId
        })
            .from(schema.contactsToLabels)
            .where(eq(schema.contactsToLabels.contactId, id))
            .all();

        const labelIds = labelRelations.map(rel => rel.labelId);

        // Parse the stored JSON data
        const data = contact.data ?? {};

        return {
            id: contact.id,
            firstName: contact.firstName.trim(),
            lastName: contact.lastName.trim(),
            eigenId: contact.eigenId,
            ...data as Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>,
            labels: labelIds
        };
    }

    public async getContacts(): Promise<Contact[]> {
        const contacts = await this.db.select().from(schema.contacts).all();
        const results = [];

        for (const contact of contacts) {
            const labelRelations = this.db.select({
                labelId: schema.contactsToLabels.labelId
            })
                .from(schema.contactsToLabels)
                .where(eq(schema.contactsToLabels.contactId, contact.id))
                .all();

            const labelIds = labelRelations.map(rel => rel.labelId);

            // Parse the stored JSON data
            const data = contact.data ?? {};

            results.push({
                id: contact.id,
                firstName: contact.firstName.trim(),
                lastName: contact.lastName.trim(),
                eigenId: contact.eigenId,
                ...data as Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>,
                labels: labelIds
            });
        }

        return results;
    }

    public async uploadAvatar(file: File) {
        this.cleanupAvatarImages();

        const buffer = Buffer.from(await file.arrayBuffer());
        const thumbnail = await generateThumbnail(buffer, file.type, {
            maxSize: 512,
            quality: 80,
            format: 'webp',
            fit: 'cover'
        });

        if (!thumbnail) {
            throw new Error('Failed to generate avatar thumbnail');
        }

        const fileName = `${uuidv4()}.webp`;
        await this.storage.write(`${PATHS.CONTACTS.AVATARS}/${fileName}`, thumbnail);

        return `contacts/avatar/${fileName}`;
    }

    public async downloadAvatar(filename: string) {
        const file = this.storage.read(`avatars/${filename}`);
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
            const contact = contacts.find(c => c.avatar?.includes(file));
            if (!contact) {
                await this.storage.delete(`avatars/${file}`);
            }
        }
    }

    private async addYourself() {
        const user = this.home.user;
        const nameParts = (user.name || '').split(' ');
        // add the user to the contacts table
        await this.addContact({
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
            labels: []
        });
        return user.id;
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
}