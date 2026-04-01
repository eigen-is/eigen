import type { DriveACL, DrivePathDetails, DrivePathType, DriveVisibility } from '@workspace/lib/types/drive';
import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const paths = sqliteTable('paths', {
    id: text('id').primaryKey(),
    file: text('file').notNull().default(''),
    name: text('name').notNull(),
    type: text('type').notNull().$type<DrivePathType>(),
    parentId: text('parentId'),
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    size: integer('size').default(0),
    thumbnail: text('thumbnail'),
    acl: text('acl', { mode: 'json' }).$type<DriveACL[] | null>(),
    visibility: text('visibility').$type<DriveVisibility>().default('private'),
    sharingRestricted: integer('sharingRestricted').notNull().default(0),
    details: text('details', { mode: 'json' }).$type<DrivePathDetails>(),
    hash: text('hash'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    trashedAt: integer('trashedAt', { mode: 'timestamp' }),
    trashedFrom: text('trashedFrom'),
});

export const labels = sqliteTable('labels', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const pathsToLabels = sqliteTable(
    'paths_to_labels',
    {
        pathId: text('pathId')
            .notNull()
            .references(() => paths.id, { onDelete: 'cascade' }),
        labelId: text('labelId')
            .notNull()
            .references(() => labels.id, { onDelete: 'cascade' }),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.pathId, table.labelId] }),
    }),
);

export type MountSchema = {
    paths: typeof paths;
    labels: typeof labels;
    pathsToLabels: typeof pathsToLabels;
};
