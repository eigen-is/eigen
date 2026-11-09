// The Drizzle tables of a home's shared.db: its copy of the paths other owners shared with it, behind "Shared with
// me", and the paths its user opened or was notified about, behind Recent. The drive's migrations create them.

import type { DriveACL, DrivePathDetails, DrivePathType, DriveVisibility } from '@workspace/lib/types/drive';
import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sharedPaths = sqliteTable('shared_paths', {
    id: text('id').primaryKey(),
    mountId: text('mountId').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<DrivePathType>(),
    parentId: text('parentId'),
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size').notNull().default(0),
    thumbnail: text('thumbnail'),
    acl: text('acl', { mode: 'json' }).$type<DriveACL[] | null>(),
    visibility: text('visibility').notNull().$type<DriveVisibility>().default('private'),
    sharingRestricted: integer('sharingRestricted', { mode: 'boolean' }).notNull().default(false),
    details: text('details', { mode: 'json' }).$type<DrivePathDetails>(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

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
