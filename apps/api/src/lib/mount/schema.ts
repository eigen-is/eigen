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

// WebDAV dead properties (RFC 4918 §3) — opaque key/value pairs stored verbatim
// per resource. Live properties (displayname, getetag, etc.) are derived from the
// path row and intentionally rejected by PROPPATCH; see PROTECTED_PROPS in proppatch.ts.
export const webdavDeadProps = sqliteTable(
    'webdav_dead_props',
    {
        pathId: text('pathId').notNull(),
        namespace: text('namespace').notNull(),
        name: text('name').notNull(),
        value: text('value').notNull(),
    },
    (t) => ({
        pk: primaryKey({ columns: [t.pathId, t.namespace, t.name] }),
    }),
);
