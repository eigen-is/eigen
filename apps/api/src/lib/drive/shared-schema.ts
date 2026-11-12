// The Drizzle tables of a home's shared.db: which paths other owners shared with it, behind "Shared with me", and
// which paths its user opened or was notified about, behind Recent. A row only names a path, and a listing reads the
// rest from the path's owner. The drive's migrations create them.

import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sharedPaths = sqliteTable(
    'shared_paths',
    {
        ownerId: text('ownerId').notNull(),
        mountId: text('mountId').notNull(),
        pathId: text('pathId').notNull(),
        sharedAt: integer('sharedAt', { mode: 'timestamp' }).notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.ownerId, table.mountId, table.pathId] }),
    }),
);

export const recentPaths = sqliteTable(
    'recent_paths',
    {
        ownerId: text('ownerId').notNull(),
        mountId: text('mountId').notNull(),
        pathId: text('pathId').notNull(),
        lastActivityAt: integer('lastActivityAt', { mode: 'timestamp' }).notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.ownerId, table.mountId, table.pathId] }),
    }),
);
