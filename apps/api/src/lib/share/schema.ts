import {primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

export const shareRegistry = sqliteTable('share_registry', {
    fromUserId: text('fromUserId').notNull(),
    targetIdentifier: text('targetIdentifier').notNull(),
}, (table) => ({
    pk: primaryKey({columns: [table.fromUserId, table.targetIdentifier]}),
}));
