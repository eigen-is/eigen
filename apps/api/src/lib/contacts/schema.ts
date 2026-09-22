import type { CreateContactInput } from '@workspace/lib/types/contact';
import { relations, sql } from 'drizzle-orm';
import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The vCard bytes are the truth; every other column of this table is a projection of them and is rebuildable from them.
export const contacts = sqliteTable('contacts', {
    id: text('id').primaryKey(),
    uri: text('uri').notNull(),
    uid: text('uid').notNull(),
    vcard: blob('vcard', { mode: 'buffer' }).notNull(),
    firstName: text('firstName').notNull(),
    lastName: text('lastName').notNull(),
    eigenId: text('eigenId').notNull().default(''),
    isGroup: integer('isGroup', { mode: 'boolean' }).notNull().default(false),
    data: text('data', { mode: 'json' }).$type<
        Omit<CreateContactInput, 'firstName' | 'lastName' | 'eigenId' | 'labels'>
    >(),
    etag: text('etag').notNull(),
    cardCtag: integer('cardCtag').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const book = sqliteTable('book', {
    id: integer('id').primaryKey(),
    ctag: integer('ctag').notNull().default(0),
    syncGen: integer('syncGen').notNull().default(1),
    // One-shot latch for the onboarding owner-contact seed: set once init has considered a real org owner
    // (added them or found them already present) so a later deliberate delete is never resurrected.
    ownerSeeded: integer('ownerSeeded').notNull().default(0),
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
