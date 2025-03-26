import type {User} from "better-auth";
import type Database from "bun:sqlite";
import {fsGetDatabase} from "../fs/fs";
import type {Contact} from "../../types/contact";
import type {Label} from "../../types/label";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {eq, sql} from "drizzle-orm";
import * as schema from "./schema";
import {v4 as uuidv4} from "uuid";

async function getContactsDatabase(user: User) {
    const db = await fsGetDatabase(user, 'eigen.contacts/contacts.db', true, async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                firstName TEXT NOT NULL,
                lastName TEXT NOT NULL,
                eigenId TEXT,
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
            const dr = drizzle(db, { schema });
        
            // Mock labels to add if none exist
            const mockLabels: Label[] = [
                { id: uuidv4(), name: 'Family', color: '#f87171' },
                { id: uuidv4(), name: 'Friends', color: '#60a5fa' },
                { id: uuidv4(), name: 'Work', color: '#4ade80' },
                { id: uuidv4(), name: 'Important', color: '#facc15' }
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

        // add the user to the contacts table
        addContact(user, {
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
    }); 

    return drizzle(db, { schema });
}

async function setContactLabels(user: User, contactId: string, labels: string[]) {
    const db = await getContactsDatabase(user);
    
    // Delete existing labels
    await db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, contactId));
    
    // Insert new labels
    for (const labelId of labels) {
        await db.insert(schema.contactsToLabels).values({
            contactId,
            labelId
        });
    }
}

export async function addContact(user: User, contact: Omit<Contact, 'id'>) {
    const db = await getContactsDatabase(user);
    const contactId = uuidv4();
    
    const { labels, ...contactData } = contact;
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

    await db.insert(schema.contacts).values({
        id: contactId,
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        eigenId: contactData.eigenId || '',
        data,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    });
    
    // Add labels if provided
    await setContactLabels(user, contactId, labels || []);
    
    return contactId;
}

export async function deleteContact(user: User, id: string) {
    const db = await getContactsDatabase(user);
    await db.delete(schema.contacts).where(eq(schema.contacts.id, id));
}

export async function updateContact(user: User, id: string, contact: Omit<Contact, 'id'>) {
    const db = await getContactsDatabase(user);
    const { labels, ...contactData } = contact;
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
    await db.update(schema.contacts)
        .set({
            firstName: contactData.firstName,
            lastName: contactData.lastName,
            eigenId: contactData.eigenId || '',
            data,
            updatedAt: sql`unixepoch()`
        })
        .where(eq(schema.contacts.id, id));
    
    // Update labels if provided
    await setContactLabels(user, id, labels || []);
}

export async function getContactLabels(user: User): Promise<Label[]> {
    const db = await getContactsDatabase(user);
    return db.select().from(schema.labels).all();
}

export async function addContactLabel(user: User, label: Omit<Label, 'id'>): Promise<string> {
    const db = await getContactsDatabase(user);
    const labelId = uuidv4();
    
    await db.insert(schema.labels).values({
        id: labelId,
        name: label.name,
        color: label.color,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    });
    
    return labelId;
}

export async function updateContactLabel(user: User, id: string, label: Omit<Label, 'id'>) {
    const db = await getContactsDatabase(user);
    
    console.log('Updating label:', id, label);
    
    try {
        await db.update(schema.labels)
            .set({
                name: label.name,
                color: label.color,
                updatedAt: sql`unixepoch()`
            })
            .where(eq(schema.labels.id, id));
            
        console.log('Label updated successfully');
        
        // Return the updated label
        const updatedLabel = await db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
        console.log('Updated label:', updatedLabel);
        return updatedLabel;
    } catch (error) {
        console.error('Error updating label:', error);
        throw error;
    }
}

export async function deleteContactLabel(user: User, id: string) {
    const db = await getContactsDatabase(user);
    await db.delete(schema.labels).where(eq(schema.labels.id, id));
    await db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.labelId, id));
}

export async function getContactById(user: User, id: string): Promise<Contact | null> {
    const db = await getContactsDatabase(user);
    
    const contact = await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
    
    if (!contact) return null;
    
    const labelRelations = await db.select({
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

export async function getContacts(user: User): Promise<Contact[]> {
    const db = await getContactsDatabase(user);
    
    const contacts = await db.select().from(schema.contacts).all();
    const results = [];
    
    for (const contact of contacts) {
        const labelRelations = await db.select({
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
