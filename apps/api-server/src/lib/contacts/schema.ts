import {relations, sql} from 'drizzle-orm';
import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {type Contact} from '../../types/contact';

// Contacts table
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  firstName: text('firstName').notNull(),
  lastName: text('lastName').notNull(),
  eigenId: text('eigenId').notNull(),
  data: text('data', { mode: 'json' }).$type<Omit<Contact, 'id' | 'firstName' | 'lastName' | 'labels'>>(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Labels table
export const labels = sqliteTable('labels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Junction table for contacts and labels
export const contactsToLabels = sqliteTable('contacts_to_labels', {
  contactId: text('contactId').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  labelId: text('labelId').notNull().references(() => labels.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.contactId, table.labelId] }),
}));

// Establish relations
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

// Types based on the schema
export type ContactInsert = typeof contacts.$inferInsert;
export type ContactSelect = typeof contacts.$inferSelect;
export type LabelInsert = typeof labels.$inferInsert;
export type LabelSelect = typeof labels.$inferSelect;
export type ContactToLabelInsert = typeof contactsToLabels.$inferInsert;
export type ContactToLabelSelect = typeof contactsToLabels.$inferSelect;