import { sql } from 'drizzle-orm';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// YJS document updates table
export const docUpdates = sqliteTable('docUpdates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  updateData: blob('updateData').notNull(), // Store uint8array as binary blob
  createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  userId: text('userId').notNull(), // User who made the update
});
