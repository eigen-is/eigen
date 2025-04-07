// save DrivePath to database, acl is a json field / object
// also make a junction table for drive paths and labels

import {relations, sql} from 'drizzle-orm';
import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {DriveACL} from '../../types/drive';

// Drive paths table
export const drivePaths = sqliteTable('drive_paths', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<"folder" | "file" | "eigendocs" | "eigennotes">(),
    parentId: text('parentId'),  // We'll reference this in the relations
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size'),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<DriveACL[] | null>(),
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

// Define relations with self-reference for folders
export const drivePathsRelations = relations(drivePaths, ({many, one}) => ({
    labels: many(drivePathsToLabels),
    parent: one(drivePaths, {
        fields: [drivePaths.parentId],
        references: [drivePaths.id],
    }),
    children: many(drivePaths),
}));

export const driveLabelsRelations = relations(driveLabels, ({many}) => ({
    drivePaths: many(drivePathsToLabels),
}));

export const drivePathsToLabelsRelations = relations(drivePathsToLabels, ({one}) => ({
    drivePath: one(drivePaths, {
        fields: [drivePathsToLabels.drivePathId],
        references: [drivePaths.id],
    }),
    label: one(driveLabels, {
        fields: [drivePathsToLabels.labelId],
        references: [driveLabels.id],
    }),
}));

// Types based on the schema
export type DrivePathInsert = typeof drivePaths.$inferInsert;
export type DrivePathSelect = typeof drivePaths.$inferSelect;
export type DriveLabelInsert = typeof driveLabels.$inferInsert;
export type DriveLabelSelect = typeof driveLabels.$inferSelect;
export type DrivePathToLabelInsert = typeof drivePathsToLabels.$inferInsert;
export type DrivePathToLabelSelect = typeof drivePathsToLabels.$inferSelect;
