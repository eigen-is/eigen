import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const waitlist = sqliteTable('waitlist', {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    notes: text('notes').notNull().default(''),
    status: text('status').notNull().default('pending'),
    inviteToken: text('inviteToken').unique(),
    inviteExpiresAt: integer('inviteExpiresAt', { mode: 'timestamp' }),
    invitedAt: integer('invitedAt', { mode: 'timestamp' }),
    registeredAt: integer('registeredAt', { mode: 'timestamp' }),
    userId: text('userId'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});
