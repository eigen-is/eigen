import {blob, int, sqliteTable, text} from 'drizzle-orm/sqlite-core';

// Mailboxes table
export const mailboxes = sqliteTable('mailboxes', {
    id: int().primaryKey({autoIncrement: true}),
    name: text().notNull().unique(),
    subscribed: int().notNull().default(0),
    attributes: text().notNull().default('')
});

// Messages table
export const messages = sqliteTable('messages', {
    id: int().primaryKey({autoIncrement: true}),
    mailbox_id: int().references(() => mailboxes.id),
    subject: text(),
    sender: text(),
    recipients: text(),
    date_sent: text(),
    date_received: text(),
    raw_message: text()
});

// Attachments table
export const attachments = sqliteTable('attachments', {
    id: int().primaryKey({autoIncrement: true}),
    message_id: int().notNull().references(() => messages.id),
    filename: text(),
    content_type: text(),
    data: blob()
});

// Message flags table
export const messageFlags = sqliteTable('message_flags', {
    message_id: int().notNull().references(() => messages.id),
    flag: text().notNull()
});