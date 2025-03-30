import type Database from "bun:sqlite";
import type {Contact} from "../../types/contact";
import type {Label} from "../../types/label";
import {BunSQLiteDatabase, drizzle} from "drizzle-orm/bun-sqlite";
import {eq, sql} from "drizzle-orm";
import * as schema from "./schema";
import {v4 as uuidv4} from "uuid";
import {getHome, Home} from "../home/home";
import type {User} from "better-auth/types";
import {getUserByEmail} from "../users/users.ts";
import { fsGetDirName } from "../fs/fs.ts";

export async function getContacts(user: User) {
    const home = await getHome(user);
   // const contacts = new Contacts(home);
   // await contacts.init();
   // return contacts;
    return home.contacts;
}

async function getContactsDatabase(home: Home) {
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
            // Initialize drizzle
            const dr = drizzle(db, {schema});

            // Mock labels to add if none exist
            const mockLabels: Label[] = [
                {id: uuidv4(), name: 'Family', color: '#f87171'},
                {id: uuidv4(), name: 'Friends', color: '#60a5fa'},
                {id: uuidv4(), name: 'Work', color: '#4ade80'},
                {id: uuidv4(), name: 'Important', color: '#facc15'}
            ];

            // Check if labels already exist
            const existingLabels = await dr.select().from(schema.labels).all();
            console.log('Existing labels:', existingLabels);

            // Only add mock labels if none exist
            if (existingLabels.length === 0) {
                console.log('Adding mock labels...');
                for (const label of mockLabels) {
                    await dr.insert(schema.labels).values({
                        id: label.id,
                        name: label.name,
                        color: label.color
                    });
                }
                console.log('Mock labels added successfully');
            }
        } catch (error) {
            console.error('Error setting up mock labels:', error);
        }
    });

    return drizzle(db, {schema});
}

export class Contacts {
    private db!: BunSQLiteDatabase<typeof schema>;
    private home: Home;

    constructor(home: Home) {
        this.home = home;
    }

    public async init() {
        this.db = await getContactsDatabase(this.home);
        if (!(await this.getContacts()).length) {
            const user = this.home.user;

            // add the user to the contacts table
            await this.addContact({
                eigenId: user.id,
                firstName: user.name,
                lastName: '',
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

            // get reinder
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

        const {labels, ...contactData} = contact;
        const data = {
            email: contactData.email,
            phone: contactData.phone,
            company: contactData.company,
            jobTitle: contactData.jobTitle,
            address: contactData.address,
            birthday: contactData.birthday,
            notes: contactData.notes,
            avatar: contactData.avatar
        };

        await this.db.insert(schema.contacts).values({
            id: contactId,
            firstName: contactData.firstName,
            lastName: contactData.lastName,
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
        const user = this.home.user;
        // you can't delete yourself!
        if (id === user.id) {
            throw new Error('You cannot delete yourself');
        } else {
            await this.db.delete(schema.contacts).where(eq(schema.contacts.id, id));
        }
    }


    public async updateContact(id: string, contact: Omit<Contact, 'id'>) {
        const {labels, ...contactData} = contact;
        const data = {
            email: contactData.email,
            phone: contactData.phone,
            company: contactData.company,
            jobTitle: contactData.jobTitle,
            address: contactData.address,
            birthday: contactData.birthday,
            notes: contactData.notes,
            avatar: contactData.avatar
        };

        // Update contact
        await this.db.update(schema.contacts)
            .set({
                firstName: contactData.firstName,
                lastName: contactData.lastName,
                eigenId: contactData.eigenId || '',
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
            name: label.name,
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
                    name: label.name,
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
            firstName: contact.firstName,
            lastName: contact.lastName,
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
                firstName: contact.firstName,
                lastName: contact.lastName,
                eigenId: contact.eigenId,
                ...data as Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>,
                labels: labelIds
            });
        }

        return results;
    }

    public async uploadAvatar(file: File) {   
        // create random file name in 'eigen.contacts/avatars' with correct extension
        const baseDir =  fsGetDirName(this.home.user, 'eigen.contacts/avatars/');
        const extension = file.name.split('.').pop();
        // create file name
        const fileName = `${uuidv4()}.${extension}`;
        const fullFileName = `${baseDir}${fileName}`;

        await Bun.write(fullFileName, file);

        return `${process.env['VITE_API_HOST']}/contacts/avatar/${fileName}`;
    }

    public async downloadAvatar(filename: string  ) {
        // return file if exists with correct headers
        const filePath = `${fsGetDirName(this.home.user, 'eigen.contacts/avatars/')}${filename}`;
        const file = Bun.file(filePath);
        if (!file.exists()) {
            return null;
        }
        return file.arrayBuffer();
    }
}