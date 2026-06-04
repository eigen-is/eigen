import type { ChatAttachment, ChatMessageType } from '@workspace/lib/types/chat';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable('messages', {
    id: text('id').primaryKey(),
    authorId: text('authorId').notNull(),
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

export const readState = sqliteTable('read_state', {
    userId: text('userId').primaryKey(),
    lastReadMessageId: text('lastReadMessageId'),
    lastReadAt: integer('lastReadAt', { mode: 'timestamp' }),
});
