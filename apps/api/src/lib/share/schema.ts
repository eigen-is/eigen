// The share registry's one table: a pair of the owner who shared and the address or team they shared with.

import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const shareRegistry = sqliteTable(
    'share_registry',
    {
        fromUserId: text('fromUserId').notNull(),
        targetIdentifier: text('targetIdentifier').notNull(),
    },
    (table) => [primaryKey({ columns: [table.fromUserId, table.targetIdentifier] })],
);
