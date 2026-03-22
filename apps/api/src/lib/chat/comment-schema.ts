import {sql} from 'drizzle-orm';
import {index, integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

export const comments = sqliteTable('comments', {
    chatName: text('chatName').primaryKey(),
    status: text('status').notNull().default('open').$type<'open' | 'resolved'>(),
    resolvedBy: text('resolvedBy'),
    resolvedAt: integer('resolvedAt', {mode: 'timestamp'}),
    lastAuthorEmail: text('lastAuthorEmail'),
    lastMessageSnippet: text('lastMessageSnippet'),
    lastActivityAt: integer('lastActivityAt', {mode: 'timestamp'}),
    messageCount: integer('messageCount').notNull().default(0),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});

export const commentMentions = sqliteTable('comment_mentions', {
    chatName: text('chatName').notNull(),
    email: text('email').notNull(),
}, (table) => ({
    pk: primaryKey({columns: [table.chatName, table.email]}),
    emailIdx: index('idx_mentions_email').on(table.email),
}));
