import {sql} from 'drizzle-orm';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {DriveACL, DrivePathDetails} from '@workspace/lib/types/drive';

export const sharedPaths = sqliteTable('shared_paths', {
    id: text('id').primaryKey(),
    mountId: text('mountId').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<"folder" | "file" | "doc" | "stickies" | "chat" | "chatroom">(),
    parentId: text('parentId'),  // We'll reference this in the relations
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size'),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<DriveACL[] | null>(),
    details: text('details', {mode: 'json'}).$type<DrivePathDetails>(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});