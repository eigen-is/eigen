import {sql} from 'drizzle-orm';
import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import type {ACLEntry} from './types';

export const paths = sqliteTable('paths', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<'folder' | 'file' | 'doc' | 'stickies'>(),
    parentId: text('parentId'),
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size').default(0),
    thumbnail: text('thumbnail'),
    acl: text('acl', {mode: 'json'}).$type<ACLEntry[] | null>(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

export const labels = sqliteTable('labels', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: integer('createdAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', {mode: 'timestamp'}).default(sql`(unixepoch())`),
});

export const pathsToLabels = sqliteTable('paths_to_labels', {
    pathId: text('pathId').notNull().references(() => paths.id, {onDelete: 'cascade'}),
    labelId: text('labelId').notNull().references(() => labels.id, {onDelete: 'cascade'}),
}, (table) => ({
    pk: primaryKey({columns: [table.pathId, table.labelId]}),
}));

export type MountSchema = {
    paths: typeof paths;
    labels: typeof labels;
    pathsToLabels: typeof pathsToLabels;
};

export const MOUNT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS paths (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parentId TEXT,
    ownerId TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    thumbnail TEXT,
    acl TEXT,
    createdAt INTEGER DEFAULT (unixepoch()),
    updatedAt INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    createdAt INTEGER DEFAULT (unixepoch()),
    updatedAt INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS paths_to_labels (
    pathId TEXT NOT NULL,
    labelId TEXT NOT NULL,
    PRIMARY KEY (pathId, labelId),
    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE,
    FOREIGN KEY (labelId) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paths_parentId ON paths(parentId);
CREATE INDEX IF NOT EXISTS idx_paths_ownerId ON paths(ownerId);
CREATE INDEX IF NOT EXISTS idx_paths_type ON paths(type);
CREATE INDEX IF NOT EXISTS idx_paths_to_labels_pathId ON paths_to_labels(pathId);
CREATE INDEX IF NOT EXISTS idx_paths_to_labels_labelId ON paths_to_labels(labelId);
`;
