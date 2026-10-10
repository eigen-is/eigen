import type { ChatAttachment, ChatMessageType } from '@workspace/lib/types/chat';
import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
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

// The messages a search indexes: live ones, never a whisper, whose text only its two participants may read.
export const SEARCHABLE_MESSAGES = and(isNull(messages.deletedAt), ne(messages.type, 'whisper'));

export function olderThan(cursor: { createdAt: Date; rowid: number }) {
    return or(
        lt(messages.createdAt, cursor.createdAt),
        and(eq(messages.createdAt, cursor.createdAt), lt(sql`rowid`, cursor.rowid)),
    );
}
