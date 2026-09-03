import type { DriveACL, DrivePathDetails, DrivePathType, DriveVisibility } from '@workspace/lib/types/drive';
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
    // NULL = the folder-size cache was invalidated; recomputed lazily (invalidateSizesFrom / computeFolderSizeInTx).
    size: integer('size').default(0),
    thumbnail: text('thumbnail'),
    acl: text('acl', { mode: 'json' }).$type<DriveACL[] | null>(),
    visibility: text('visibility').$type<DriveVisibility>().default('private'),
    sharingRestricted: integer('sharingRestricted', { mode: 'boolean' }).notNull().default(false),
    details: text('details', { mode: 'json' }).$type<DrivePathDetails>(),
    hash: text('hash'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    trashedAt: integer('trashedAt', { mode: 'timestamp' }),
    trashedFrom: text('trashedFrom'),
    // Drive-wide content search (metadata.db v6). contentDirty is set on a real body
    // write (plaintext at the file-write seam; containers via onSync) and drained by the
    // content-reindex sweep. contentIndexedAt drives the 2-min per-container re-extract cap.
    contentDirty: integer('contentDirty').notNull().default(0),
    contentIndexedAt: integer('contentIndexedAt', { mode: 'timestamp' }),
});

// Write-behind upload queue for S3-backed mounts (Phase 1b). One row per storage key
// with an upload owed; deleted on ack. Local to metadata.db so the queue's own state is
// synchronously durable, transactional with the path rows it guards, and moves with the
// Home. `stagingPath` is the BASENAME of a frozen VACUUM INTO copy in the mount's stagingDir
// (resolved at read time so it survives a data-dir relocation); epochs are plain ms numbers.
export const pendingUploads = sqliteTable('pending_uploads', {
    storageKey: text('storageKey').primaryKey(),
    stagingPath: text('stagingPath').notNull(),
    attempt: integer('attempt').notNull().default(0),
    enqueuedAt: integer('enqueuedAt').notNull(),
    nextAttemptAt: integer('nextAttemptAt').notNull(),
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
