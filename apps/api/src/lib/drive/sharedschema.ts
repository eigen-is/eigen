import type { DriveACL, DrivePathDetails, DrivePathType, DriveVisibility } from '@workspace/lib/types/drive';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
