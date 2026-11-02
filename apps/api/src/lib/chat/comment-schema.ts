// The Drizzle tables of a document's comment index: one row per comment thread, and one row per
// person mentioned in a thread. The index's database config creates and migrates the tables. This
// file describes them for the Drizzle queries.

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The table also has a lastMessageSnippet column from its first version. Nothing reads it, so the
// schema leaves it out, and new rows leave it empty.
export const comments = sqliteTable('comments', {
    chatName: text('chatName').primaryKey(),
    status: text('status').notNull().default('open').$type<'open' | 'resolved'>(),
    resolvedBy: text('resolvedBy'),
    resolvedAt: integer('resolvedAt', { mode: 'timestamp' }),
    lastAuthorEmail: text('lastAuthorEmail'),
    lastActivityAt: integer('lastActivityAt', { mode: 'timestamp' }),
    messageCount: integer('messageCount').notNull().default(0),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    createdBy: text('createdBy'),
    // The newest 8 KB of the thread's text, newest message first. Comment search indexes it.
    recentText: text('recentText'),
    // The assigned member's email in lower case, or null when nobody is assigned.
    assignee: text('assignee'),
    // A copy of the card title, which the client sends with each assign or status change. It can be
    // out of date.
    title: text('title'),
});

export const commentMentions = sqliteTable(
    'comment_mentions',
    {
        chatName: text('chatName').notNull(),
        email: text('email').notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.chatName, table.email] }),
        emailIdx: index('idx_mentions_email').on(table.email),
    }),
);
