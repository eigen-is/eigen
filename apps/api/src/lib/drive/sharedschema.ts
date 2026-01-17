import {sql} from 'drizzle-orm';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {ACLEntry} from '../mount/types';

export const sharedPaths = sqliteTable('shared_paths', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<"folder" | "file" | "doc" | "stickies">(),
    parentId: text('parentId'),  // We'll reference this in the relations
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size'),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<ACLEntry[] | null>(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});