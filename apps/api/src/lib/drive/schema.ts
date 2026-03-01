// save DrivePath to database, acl is a json field / object
// also make a junction table for drive paths and labels

import {sql} from 'drizzle-orm';
import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {DriveACL, DrivePathDetails, DriveVisibility} from '@workspace/lib/types/drive';

// Drive paths table
export const drivePaths = sqliteTable('drive_paths', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<"folder" | "file" | "doc" | "stickies">(),
    parentId: text('parentId'),  // We'll reference this in the relations
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size'),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<DriveACL[] | null>(),
    visibility: text('visibility').$type<DriveVisibility>().default('private'),
    details: text('details', {mode: 'json'}).$type<DrivePathDetails>(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

// Labels table
export const driveLabels = sqliteTable('drive_labels', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

// Junction table for drive paths and labels
export const drivePathsToLabels = sqliteTable('drive_paths_to_labels', {
    drivePathId: text('drivePathId').notNull().references(() => drivePaths.id, {onDelete: 'cascade'}),
    labelId: text('labelId').notNull().references(() => driveLabels.id, {onDelete: 'cascade'}),
}, (table) => ({
    pk: primaryKey({columns: [table.drivePathId, table.labelId]}),
}));
