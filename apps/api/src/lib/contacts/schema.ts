import type { Contact } from '@workspace/lib/types/contact';
import { relations, sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const contacts = sqliteTable('contacts', {
    id: text('id').primaryKey(),
    uri: text('uri').notNull(),
    uriKey: text('uriKey').notNull(),
    uid: text('uid').notNull(),
    firstName: text('firstName').notNull(),
    lastName: text('lastName').notNull(),
    eigenId: text('eigenId').notNull().default(''),
    isGroup: integer('isGroup', { mode: 'boolean' }).notNull().default(false),
    data: text('data', { mode: 'json' }).$type<Omit<Contact, 'id' | 'firstName' | 'lastName' | 'eigenId' | 'labels'>>(),
    etag: text('etag').notNull(),
    cardCtag: integer('cardCtag').notNull(),
    mtime: integer('mtime').notNull(),
    size: integer('size').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const book = sqliteTable('book', {
    id: integer('id').primaryKey(),
    ctag: integer('ctag').notNull().default(0),
    syncGen: integer('syncGen').notNull().default(1),
});

export const contactTombstones = sqliteTable('contact_tombstones', {
    uri: text('uri').primaryKey(),
    deletedAtCtag: integer('deletedAtCtag').notNull(),
});

export const labels = sqliteTable('labels', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameKey: text('nameKey').notNull(),
    color: text('color').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const contactsToLabels = sqliteTable(
    'contacts_to_labels',
    {
        contactId: text('contactId')
            .notNull()
            .references(() => contacts.id, { onDelete: 'cascade' }),
        labelId: text('labelId')
            .notNull()
            .references(() => labels.id, { onDelete: 'cascade' }),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.contactId, table.labelId] }),
    }),
);

export const contactsRelations = relations(contacts, ({ many }) => ({
    labels: many(contactsToLabels),
}));

export const labelsRelations = relations(labels, ({ many }) => ({
    contacts: many(contactsToLabels),
}));

export const contactsToLabelsRelations = relations(contactsToLabels, ({ one }) => ({
    contact: one(contacts, {
        fields: [contactsToLabels.contactId],
        references: [contacts.id],
    }),
    label: one(labels, {
        fields: [contactsToLabels.labelId],
        references: [labels.id],
    }),
}));
