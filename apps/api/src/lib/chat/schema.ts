import type { ChatAttachment, ChatMessageType } from '@workspace/lib/types/chat';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable('messages', {
    id: text('id').primaryKey(),
    authorEmail: text('authorEmail').notNull(),
    type: text('type').notNull().$type<ChatMessageType>(),
    content: text('content').notNull(),
    attachments: text('attachments', { mode: 'json' }).$type<ChatAttachment[] | null>(),
    whisperTo: text('whisperTo'),
    replyTo: text('replyTo'),
    editedAt: integer('editedAt', { mode: 'timestamp' }),
    deletedAt: integer('deletedAt', { mode: 'timestamp' }),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// The keyset every page of messages walks. createdAt is whole seconds: rowid breaks the tie, so a page edge
// inside a second skips nothing.
export const NEWEST_FIRST = [desc(messages.createdAt), desc(sql`rowid`)];

export function olderThan(cursor: { createdAt: Date; rowid: number }) {
    return or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(sql`rowid`, cursor.rowid)),
    );
}
