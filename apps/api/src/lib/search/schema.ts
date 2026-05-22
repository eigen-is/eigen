import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const searchContent = sqliteTable('search_content', {
    rowid: integer('rowid').primaryKey(),
    kind: text('kind').notNull(),
    itemId: text('itemId').notNull(),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    metadata: text('metadata').notNull().default('{}'),
    sortKey: integer('sortKey').notNull().default(0),
});
