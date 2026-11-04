// What each saved version of a document names among the document's parts, and the comment cards it has in use, kept
// in the mount's metadata.db. The sweep reads a version once and writes its names here, so a later sweep need not load
// the version again. The mount only stores and returns the rows: reading a version is the sweep's work. A row goes
// with its version's row.

import { inArray, sql } from 'drizzle-orm';
import type { Mount } from './mount';
import { versionReferences } from './schema';

export type VersionReferences = typeof versionReferences.$inferSelect;

export function getVersionReferences(mount: Mount, versionPathIds: readonly string[]): VersionReferences[] {
    if (versionPathIds.length === 0) return [];
    return mount.db
        .select()
        .from(versionReferences)
        .where(inArray(versionReferences.versionPathId, [...versionPathIds]))
        .all();
}

// A row read again, such as by a newer reader, replaces the old one.
export function putVersionReferences(mount: Mount, row: VersionReferences): void {
    mount.db
        .insert(versionReferences)
        .values(row)
        .onConflictDoUpdate({
            target: versionReferences.versionPathId,
            set: { readerVersion: sql`excluded.readerVersion`, names: sql`excluded.names` },
        })
        .run();
}
