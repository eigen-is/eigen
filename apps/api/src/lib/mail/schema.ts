import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const emails = sqliteTable('emails', {
    id: text('id').primaryKey(),
    filename: text('filename').notNull(),
    subject: text('subject').notNull(),
    fromShort: text('fromShort').notNull(),
    fromAddress: text('fromAddress').notNull().default(''),
    toShort: text('toShort').notNull().default(''),
    toAddress: text('toAddress').notNull().default(''),
    recipientsAll: text('recipientsAll').notNull().default(''),
    textShort: text('textShort').notNull(),
    size: integer('size', { mode: 'number' }).notNull().default(0),
    date: integer('date', { mode: 'timestamp' }).notNull(),
    isRead: integer('isRead', { mode: 'boolean' }).notNull().default(false),
    isFlagged: integer('isFlagged', { mode: 'boolean' }).notNull().default(false),
    isDraft: integer('isDraft', { mode: 'boolean' }).notNull().default(false),
    isReplied: integer('isReplied', { mode: 'boolean' }).notNull().default(false),
    hasAttachments: integer('hasAttachments', { mode: 'boolean' }).notNull().default(false),
    mailbox: text('mailbox').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
