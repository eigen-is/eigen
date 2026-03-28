import { sql } from 'drizzle-orm';
import { blob, integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const docUpdates = sqliteTable('doc_updates', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    updateData: blob('updateData', { mode: 'buffer' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const docSnapshots = sqliteTable('doc_snapshots', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    stateData: blob('stateData', { mode: 'buffer' }).notNull(),
    lastUpdateId: integer('lastUpdateId').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
