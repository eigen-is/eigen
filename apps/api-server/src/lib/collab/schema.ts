import { sql } from 'drizzle-orm';
import { blob, integer, sqliteTable } from 'drizzle-orm/sqlite-core';

// YJS document updates table
export const docUpdates = sqliteTable('doc_updates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  updateData: blob('updateData', { mode: 'buffer' }).notNull(), // Store uint8array as binary blob
  createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`)
});
