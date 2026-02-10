import {sql} from 'drizzle-orm';
import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

// Emails table
export const emails = sqliteTable('emails', {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    fromShort: text('fromShort').notNull(),
    textShort: text('textShort').notNull(),
    size: integer('size', {mode: 'number'}).notNull().default(0),
    date: integer('date', {mode: 'timestamp'}).notNull(),
    isRead: integer('isRead', {mode: 'boolean'}).notNull().default(false),
    isStarred: integer('isStarred', {mode: 'boolean'}).notNull().default(false),
    isDraft: integer('isDraft', {mode: 'boolean'}).notNull().default(false),
    hasAttachments: integer('hasAttachments', {mode: 'boolean'}).notNull().default(false),
    mailbox: text('mailbox').notNull(),

    _isParsed: integer('_isParsed', {mode: 'boolean'}).notNull().default(false),

    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

// Labels table for email categorization
export const emailLabels = sqliteTable('email_labels', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

// Junction table for emails and labels
export const emailsToLabels = sqliteTable('emails_to_labels', {
    emailId: text('emailId').notNull().references(() => emails.id, {onDelete: 'cascade'}),
    labelId: text('labelId').notNull().references(() => emailLabels.id, {onDelete: 'cascade'}),
}, (table) => ({
    pk: primaryKey({columns: [table.emailId, table.labelId]}),
}));

