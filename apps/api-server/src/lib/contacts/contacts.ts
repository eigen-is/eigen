import type { User } from "better-auth";
import type Database from "bun:sqlite";
import { fsGetDatabase } from "../fs/fs";
import type { Contact } from "../../types/contact";
import type { Label } from "../../types/label";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { v4 as uuidv4 } from "uuid";

async function getContactsDatabase(user: User) {
    const db = await fsGetDatabase(user, 'contacts.eigen/contacts.db', true, async (db: Database) => {
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

        // Mock labels to add if none exist
        const mockLabels: Label[] = [
            { id: uuidv4(), name: 'Family', color: '#f87171' },
            { id: uuidv4(), name: 'Friends', color: '#60a5fa' },
            { id: uuidv4(), name: 'Work', color: '#4ade80' },
            { id: uuidv4(), name: 'Important', color: '#facc15' }
        ];
        
        // Initialize drizzle
        const dr = drizzle(db, { schema });
        
        try {
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
    return drizzle(db, { schema });
}

export async function getContacts(user: User) {
    const db = await getContactsDatabase(user);
    return db.select().from(schema.contacts).all().map(contact => ({
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        eigenId: contact.eigenId,
        ...(JSON.parse(contact.data) as Contact)
    }));
}

export async function getContactById(user: User, id: string) {
    const db = await getContactsDatabase(user);
    return db.select().from(schema.contacts).where(eq(schema.contacts.id, id)).get();
}

export async function addContact(user: User, contact: Omit<Contact, 'id'>) {
    const db = await getContactsDatabase(user);
    const contactId = uuidv4();
    
    const { labels, ...contactData } = contact;
    
    await db.insert(schema.contacts).values({
        id: contactId,
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        eigenId: contactData.eigenId || null,
        data: JSON.stringify({
            email: contactData.email,
            phone: contactData.phone,
            company: contactData.company,
            jobTitle: contactData.jobTitle,
            address: contactData.address,
            birthday: contactData.birthday,
            notes: contactData.notes,
            avatar: contactData.avatar
        })
    });
    
    // Add labels if provided
    if (labels && labels.length > 0) {
        for (const labelId of labels) {
            await db.insert(schema.contactsToLabels).values({
                contactId,
                labelId
            });
        }
    }
    
    return contactId;
}

export async function deleteContact(user: User, id: string) {
    const db = await getContactsDatabase(user);
    await db.delete(schema.contacts).where(eq(schema.contacts.id, id));
}

export async function updateContact(user: User, id: string, contact: Omit<Contact, 'id'>) {
    const db = await getContactsDatabase(user);
    const { labels, ...contactData } = contact;
    
    // Update contact
    await db.update(schema.contacts)
        .set({
            firstName: contactData.firstName,
            lastName: contactData.lastName,
            eigenId: contactData.eigenId || null,
            data: JSON.stringify({
                email: contactData.email,
                phone: contactData.phone,
                company: contactData.company,
                jobTitle: contactData.jobTitle,
                address: contactData.address,
                birthday: contactData.birthday,
                notes: contactData.notes,
                avatar: contactData.avatar
            }),
            updatedAt: Math.floor(Date.now() / 1000)
        })
        .where(eq(schema.contacts.id, id));
    
    // Update labels if provided
    if (labels !== undefined) {
        // Remove all existing labels
        await db.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, id));
        
        // Add new labels
        if (labels.length > 0) {
            for (const labelId of labels) {
                await db.insert(schema.contactsToLabels).values({
                    contactId: id,
                    labelId
                });
            }
        }
    }
}

export async function getContactLabels(user: User) {
    const db = await getContactsDatabase(user);
    return db.select().from(schema.labels).all();
}

export async function addContactLabel(user: User, label: Omit<Label, 'id'>) {
    const db = await getContactsDatabase(user);
    const labelId = uuidv4();
    
    await db.insert(schema.labels).values({
        id: labelId,
        name: label.name,
        color: label.color
    });
    
    return labelId;
}

export async function updateContactLabel(user: User, id: string, label: Omit<Label, 'id'>) {
    const db = await getContactsDatabase(user);
    
    await db.update(schema.labels)
        .set({
            name: label.name,
            color: label.color,
            updatedAt: Math.floor(Date.now() / 1000)
        })
        .where(eq(schema.labels.id, id));
}

export async function deleteContactLabel(user: User, id: string) {
    const db = await getContactsDatabase(user);
    await db.delete(schema.labels).where(eq(schema.labels.id, id));
}

export async function getContactWithLabels(user: User, id: string) {
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
    const data = contact.data ? JSON.parse(contact.data) : {};
    
    return {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        eigenId: contact.eigenId,
        ...data,
        labels: labelIds
    };
}

export async function getContactsWithLabels(user: User) {
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
        const data = contact.data ? JSON.parse(contact.data) : {};
        
        results.push({
            id: contact.id,
            firstName: contact.firstName,
            lastName: contact.lastName,
            eigenId: contact.eigenId,
            ...data,
            labels: labelIds
        });
    }
    
    return results;
}
