// The Drizzle tables of a mount's metadata.db, such as the tree of paths, the upload queue and the file history. Mount
// and its sibling modules query them, and the mount's migrations create them.

import type { DrivePathDetails, DrivePathType } from '@workspace/lib/types/drive';
import type { DriveACL, DriveVisibility } from '@workspace/lib/types/drive-access';
import type { FileEventDetailsMap, FileEventType } from '@workspace/lib/types/file-history';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const paths = sqliteTable('paths', {
    id: text('id').primaryKey(),
    file: text('file').notNull().default(''),
    name: text('name').notNull(),
    type: text('type').notNull().$type<DrivePathType>(),
    parentId: text('parentId'),
    ownerId: text('ownerId').notNull(),
    mimeType: text('mimeType').notNull(),
    // A folder's NULL size means its cached size was dropped, and the next read computes it again.
    size: integer('size').default(0),
    thumbnail: text('thumbnail'),
    acl: text('acl', { mode: 'json' }).$type<DriveACL[] | null>(),
    visibility: text('visibility').notNull().$type<DriveVisibility>().default('private'),
    sharingRestricted: integer('sharingRestricted', { mode: 'boolean' }).notNull().default(false),
    details: text('details', { mode: 'json' }).$type<DrivePathDetails>(),
    hash: text('hash'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    trashedAt: integer('trashedAt', { mode: 'timestamp' }),
    trashedFrom: text('trashedFrom'),
    // The Drive-wide content search. A write of a text file's body, or a container's sync, sets contentDirty, and the
    // content reindex sweep clears it. contentIndexedAt holds a container to one extract every two minutes.
    contentDirty: integer('contentDirty').notNull().default(0),
    contentIndexedAt: integer('contentIndexedAt', { mode: 'timestamp' }),
});

// The write-behind upload queue of an S3 mount: one row per storage key that still owes an upload, deleted when the
// bucket acknowledges it. It lives in metadata.db, so the queue's state is durable at once, changes in the same
// transaction as the path rows it guards, and moves with the Home. `stagingPath` is only the file name of a frozen
// staged copy in the mount's staging folder. That copy is a VACUUM INTO copy of a managed database, or a plain file a
// home restore staged. The folder is joined in at read time, so a moved data folder still works. The times are plain
// milliseconds. `isDatabase` says what the copy holds. It is true for a managed database, whose copy is refused before
// the upload if it lost its SQLite header. It is false for a plain file a restore staged, which has no header to check.
export const pendingUploads = sqliteTable('pending_uploads', {
    storageKey: text('storageKey').primaryKey(),
    stagingPath: text('stagingPath').notNull(),
    attempt: integer('attempt').notNull().default(0),
    enqueuedAt: integer('enqueuedAt').notNull(),
    nextAttemptAt: integer('nextAttemptAt').notNull(),
    isDatabase: integer('isDatabase', { mode: 'boolean' }).notNull().default(true),
});

export const fileEvents = sqliteTable(
    'file_events',
    {
        id: text('id').primaryKey(),
        pathId: text('pathId')
            .notNull()
            .references(() => paths.id, { onDelete: 'cascade' }),
        eventType: text('eventType').notNull().$type<FileEventType>(),
        actorUserId: text('actorUserId').notNull(),
        actorEmail: text('actorEmail').notNull(),
        details: text('details', { mode: 'json' }).$type<FileEventDetailsMap[keyof FileEventDetailsMap] | null>(),
        createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    },
    (table) => ({
        pathCreated: index('idx_file_events_path_created').on(table.pathId, table.createdAt),
    }),
);

export const pathWatchers = sqliteTable(
    'path_watchers',
    {
        pathId: text('pathId')
            .notNull()
            .references(() => paths.id, { onDelete: 'cascade' }),
        userId: text('userId').notNull(),
        createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.pathId, table.userId] }),
        userIdx: index('idx_path_watchers_user').on(table.userId),
    }),
);
