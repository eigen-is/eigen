import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const systemConfig = sqliteTable('system_config', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
