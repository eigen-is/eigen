// What a home archive holds, read without a live home: the home databases, and a mount's paths table turned into
// archive paths and storage keys. The backup steps share it, such as capture, verify and restore. Nothing it imports
// opens a file, so ./eigen restore can stage an archive with it while the API runs on the same data/.

import type { Database } from 'bun:sqlite';
import type { DrivePathType } from '@workspace/lib/types/drive';
import { isCollabType, isDocumentType } from '@workspace/lib/types/drive';
import { CALENDAR_DB_CONFIG } from '../calendar/db-config';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { PATHS } from '../config/paths';
import { CONTACTS_DB_CONFIG } from '../contacts/db-config';
import type { DatabaseConfig, SchemaType } from '../core/managed-database';
import { SHARED_DB_CONFIG } from '../drive/db-config';
import { MAIL_DB_CONFIG } from '../mail/db-config';
import { CONTAINER_COMMENTS_DB, CONTAINER_DATA_DB, isContainerDatabase } from '../mount/container-dbs';
import { isReservedName, isUsableName, trashStorageKey } from '../mount/names';
import { paths } from '../mount/schema';
import { NOTIFICATION_CENTER_DB_CONFIG } from '../notification-center/db-config';
import { isVersionsName } from '../versioning/versions-folder';

// Home-level databases outside the mounts. Absent files are skipped: a team home has no mail,
// contacts or notifications, and opening one through getLocalDatabase would create it empty.
export const HOME_DATABASES: [DatabaseConfig<SchemaType>, string][] = [
    [SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB],
    [MAIL_DB_CONFIG, PATHS.MAIL.DB],
    [CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB],
    [CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB],
    [NOTIFICATION_CENTER_DB_CONFIG, PATHS.NOTIFICATIONS.DB],
];

// The home's mail, by its path from the home root.
export const MAILDIR_ROOT = `${PATHS.MAIL.ROOT}/${PATHS.MAIL.MAILDIR}`;

// The columns every reader of an archived paths table wants, spelled once: readMountPathRows derives
// its SELECT list from their names, and the row type it hands back is this object's keys.
const MOUNT_PATH_COLUMNS = {
    id: paths.id,
    file: paths.file,
    name: paths.name,
    type: paths.type,
    parentId: paths.parentId,
    trashedFrom: paths.trashedFrom,
    size: paths.size,
    hash: paths.hash,
};

export type MountPathRow = Pick<typeof paths.$inferSelect, keyof typeof MOUNT_PATH_COLUMNS>;

// The databases a mount owns inside an archive: a container's data.db/comments.db and the versions/
// snapshots of one, each with the container type behind it.
type ManagedArchiveDatabase = {
    // Relative to the mount's data/ folder in the archive.
    path: string;
    // The container's own data.db, the one a Yjs decode can be run on. False for comments.db and
    // for a versions/ snapshot.
    isContainerData: boolean;
    containerType: DrivePathType;
    // The schema this file was written against, so a restore can tell a database from a newer server
    // (which ManagedDatabase would then refuse to open) before it hands the home back.
    config: DatabaseConfig<SchemaType>;
    // The row this file belongs to, so a restore can put it back at the key its mount will look for.
    row: MountPathRow;
};

// The rows of an archived metadata.db, in the shape every reader of one wants.
export function readMountPathRows(db: Database): MountPathRow[] {
    const columns = Object.values(MOUNT_PATH_COLUMNS)
        .map((column) => column.name)
        .join(', ');
    return db.query<MountPathRow, []>(`SELECT ${columns} FROM paths`).all();
}

// The name chain of every row from the root down. A row that does not reach the root, under a missing parent or in a
// parent cycle, is never met, so it has no entry. The root contributes no segment.
function pathsFromRoot(rows: readonly MountPathRow[], segment: (row: MountPathRow) => string): Map<string, string> {
    const children = Map.groupBy(rows, (row) => row.parentId);
    const walk = [...(children.get(null) ?? [])];
    const built = new Map(walk.map((root) => [root.id, '']));
    for (const parent of walk) {
        const prefix = built.get(parent.id);
        for (const child of children.get(parent.id) ?? []) {
            built.set(child.id, prefix ? `${prefix}/${segment(child)}` : segment(child));
            walk.push(child);
        }
    }
    return built;
}

function lookUp(built: ReadonlyMap<string, string>): (row: MountPathRow) => string {
    return (row) => {
        const found = built.get(row.id);
        if (found === undefined) throw new Error(`path row ${row.id} does not reach the root`);
        return found;
    };
}

// A trash root sits at `.trash/{id}.{ext}`, as trashPath spells it.
function archiveSegment(row: MountPathRow): string {
    return row.trashedFrom ? trashStorageKey(row.id, row.name) : row.name;
}

// Where each row's bytes go inside the archive: the storage key it would have on a `local` mount. Deriving it from
// metadata.db instead of the mount's own keys is what makes the archive storage-independent: local-key and s3 mounts
// store flat keys, and restore re-derives whichever shape the target mount needs.
export function archivePaths(rows: readonly MountPathRow[]): (row: MountPathRow) => string {
    return lookUp(pathsFromRoot(rows, archiveSegment));
}

// Mirrors Mount.findStorageKey from the tree already held, rather than one recursive-CTE query per file. Restore puts
// every file back at the key the restored mount looks for it under. A flat-key backend stores a file's object under
// its `file`, which a restore to one rewrites as it goes.
export function storageKeys(rows: readonly MountPathRow[], isPathBased: boolean): (row: MountPathRow) => string {
    return isPathBased ? lookUp(pathsFromRoot(rows, (row) => row.file)) : (row) => row.file;
}

// The databases the mount itself manages: a container's data.db/comments.db, and the versions/
// snapshots of one. Returns the container to lock while copying, or null for anything else: a
// user's own upload that happens to be SQLite must round-trip byte-identical.
export function managedDbContainer(row: MountPathRow, byId: ReadonlyMap<string, MountPathRow>): MountPathRow | null {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (!parent) return null;
    if (isVersionsName(parent.name)) {
        const container = parent.parentId ? byId.get(parent.parentId) : undefined;
        return container && isDocumentType(container.type) ? container : null;
    }
    return isContainerDatabase(row.name, parent.type) ? parent : null;
}

// The rows no path can be built for, by their chain or by a part a path cannot hold: a capture reads a live table, and
// leaves them out of the archive with what is inside them.
export function unreachableRows(rows: readonly MountPathRow[]): { orphaned: MountPathRow[]; unusable: MountPathRow[] } {
    const reached = pathsFromRoot(rows, archiveSegment);
    const orphaned: MountPathRow[] = [];
    const unusable: MountPathRow[] = [];
    for (const row of rows) {
        if (hasUnusablePart(row)) unusable.push(row);
        else if (!reached.has(row.id)) orphaned.push(row);
    }
    return { orphaned, unusable };
}

// A `..` or a separator in an id, a name or a file would move bytes out of the mount, and a reserved name or file is
// the trash folder itself on `local`. The one separator a live table holds is a trash root's `file` on a path-based
// mount, which must be exactly trashPath's key.
function hasUnusablePart(row: MountPathRow): boolean {
    // Empty is how a flat-key mount spells a folder row (Mount.createFolder). A file always has one, its object's key.
    const flatFolder = row.type !== 'file' && row.file === '';
    const trashKey = row.trashedFrom !== null && row.file === trashStorageKey(row.id, row.name);
    return (
        !isUsableName(row.id) ||
        !isUsableName(row.name) ||
        isReservedName(row.name) ||
        isReservedName(row.file) ||
        (!flatFolder && !trashKey && !isUsableName(row.file))
    );
}

// Which of a mount's files are Eigen's own databases, by managedDbContainer's rule. Verify needs it to know what it may
// open: a user's own SQLite upload is stored byte-identical, journal header and all, and opening it is not verify's
// business. A row of a live table that does not reach the root has no path to check.
export function listManagedDatabases(rows: readonly MountPathRow[]): ManagedArchiveDatabase[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const archivePath = pathsFromRoot(rows, archiveSegment);
    const found: ManagedArchiveDatabase[] = [];
    for (const row of rows) {
        const relPath = archivePath.get(row.id);
        if (row.type !== 'file' || relPath === undefined) continue;
        const container = managedDbContainer(row, byId);
        if (!container) continue;
        // The container is the parent of a live data.db and the grandparent of a version snapshot.
        const isContainerData = container.id === row.parentId && row.name === CONTAINER_DATA_DB;
        found.push({
            path: relPath,
            isContainerData,
            containerType: container.type,
            config: configOf(row.name, container.type),
            row,
        });
    }
    return found;
}

// Which schema a managed file carries: a comment index, or the container's own document database,
// which is Yjs for every collab type and chat's own for a chat room. A versions/ snapshot is a copy
// of the container's data.db, so it answers the same.
function configOf(name: string, containerType: DrivePathType): DatabaseConfig<SchemaType> {
    if (name === CONTAINER_COMMENTS_DB) return COMMENT_INDEX_DB_CONFIG;
    return isCollabType(containerType) ? COLLAB_DB_CONFIG : CHAT_ROOM_DB_CONFIG;
}
