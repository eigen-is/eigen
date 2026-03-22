import {sql} from 'drizzle-orm';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {DriveACL, DrivePathDetails, DrivePathType, DriveVisibility} from '@workspace/lib/types/drive';

export const sharedPaths = sqliteTable('shared_paths', {
    id: text('id').primaryKey(),
    mountId: text('mountId').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<DrivePathType>(),
    parentId: text('parentId'),  // We'll reference this in the relations
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size'),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<DriveACL[] | null>(),
    visibility: text('visibility').$type<DriveVisibility>().default('private'),
    sharingRestricted: integer('sharingRestricted').notNull().default(0),
    details: text('details', {mode: 'json'}).$type<DrivePathDetails>(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});