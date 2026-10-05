import type { Database } from 'bun:sqlite';
import { type DrivePathType, isCollabType, isDocumentType } from '@workspace/lib/types/drive';
import { CALENDAR_DB_CONFIG } from '../calendar/db-config';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { CONTACTS_DB_CONFIG } from '../contacts/db-config';
import { PATHS } from '../core/constants';
import type { DatabaseConfig, SchemaType } from '../core/managed-database';
import { SHARED_DB_CONFIG } from '../drive/db-config';
import { MAIL_DB_CONFIG } from '../mail/db-config';
import { isUsableName, trashStorageKey } from '../mount/names';
import { paths } from '../mount/schema';
import { NOTIFICATION_CENTER_DB_CONFIG } from '../notification-center/db-config';
import { VERSIONS_FOLDER_NAME } from '../versioning/versions-folder';

// What a home archive holds, read without a live home: the home databases, and a mount's paths table turned into
// archive paths and storage keys. Capture, verify and both restores share it. Nothing it imports opens a file, so
// ./eigen restore can stage an archive with it while the API runs on the same data/.

// Home-level databases outside the mounts. Absent files are skipped: a team home has no mail,
// contacts or notifications, and opening one through getLocalDatabase would create it empty.
export const HOME_DATABASES: [DatabaseConfig<SchemaType>, string][] = [
    [SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB],
    [MAIL_DB_CONFIG, PATHS.MAIL.DB],
    [CONTACTS_DB_CONFIG, PATHS.CONTACTS.DB],
    [CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB],
    [NOTIFICATION_CENTER_DB_CONFIG, PATHS.NOTIFICATIONS.DB],
];

// The home's mail, which a Light archive leaves where it is.
export const MAILDIR_ROOT = `${PATHS.MAIL.ROOT}/${PATHS.MAIL.MAILDIR}`;

// The folders a Light archive leaves where they are, by their path from the home root: the Maildir, and every folder
// inside a mount (its files, thumbnails and staging), so of a mount only its metadata.db goes.
const LIGHT_SKIPPED = new RegExp(`^(?:${MAILDIR_ROOT}|${PATHS.DRIVE.ROOT}/[^/]+/[^/]+)$`);

export function isLightSkipped(rel: string): boolean {
    return LIGHT_SKIPPED.test(rel);
}

// Home-relative paths of the databases above; verify reads them back to know which archived .db
// files are Eigen's own.
export const HOME_DATABASE_PATHS = new Set(HOME_DATABASES.map(([, relPath]) => relPath));

// The columns every reader of an archived paths table wants, spelled once: readMountPathRows derives
// its SELECT list from their names, and the row type it hands back is this object's keys.
export const MOUNT_PATH_COLUMNS = {
    id: paths.id,
    file: paths.file,
    name: paths.name,
    type: paths.type,
    parentId: paths.parentId,
    trashedFrom: paths.trashedFrom,
    size: paths.size,
    hash: paths.hash,
};

type MountPathRow = Pick<typeof paths.$inferSelect, keyof typeof MOUNT_PATH_COLUMNS>;

// The databases a mount owns inside an archive: a container's data.db/comments.db and the versions/
// snapshots of one, each with the container type behind it.
type ManagedArchiveDatabase = {
    // Relative to the mount's data/ folder in the archive.
    path: string;
    // The container's own data.db — the one a Yjs decode can be run on. False for comments.db and
    // for a versions/ snapshot.
    isContainerData: boolean;
    containerType: DrivePathType;
    // The schema this file was written against, so a restore can tell a database from a newer server
    // (which ManagedDatabase would then refuse to open) before it hands the home back.
    config: DatabaseConfig<SchemaType>;
    // The row this file belongs to, so a restore can put it back at the key its mount will look for.
    row: MountPathRow;
};

// The two databases a container owns; a mount never manages any other (see mount/document-db.ts).
const CONTAINER_DATA_DB = 'data.db';
const CONTAINER_COMMENTS_DB = 'comments.db';
const CONTAINER_DB_NAMES = new Set([CONTAINER_DATA_DB, CONTAINER_COMMENTS_DB]);

// Which schema a managed file carries: a comment index, or the container's own document database —
// Yjs for every collab type, chat's own for a chat room. A versions/ snapshot is a copy of the
// container's data.db, so it answers the same.
function configOf(name: string, containerType: DrivePathType): DatabaseConfig<SchemaType> {
    if (name === CONTAINER_COMMENTS_DB) return COMMENT_INDEX_DB_CONFIG;
    return isCollabType(containerType) ? COLLAB_DB_CONFIG : CHAT_ROOM_DB_CONFIG;
}

// Ancestors of `row`, nearest first. Guarded against a corrupt parentId cycle, which would
// otherwise spin forever on a table the backup does not get to trust.
function* ancestors(row: MountPathRow, byId: Map<string, MountPathRow>): Generator<MountPathRow> {
    const seen = new Set<string>([row.id]);
    let current = row.parentId ? byId.get(row.parentId) : undefined;
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        yield current;
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
}

// Where a row's bytes go inside the archive: the storage key it WOULD have on a `local` mount —
// the name chain from the root, with a trash root at `.trash/{id}.{ext}` as trashPath spells it.
// Deriving it from metadata.db instead of the mount's own keys is what makes the archive
// storage-independent: local-key and s3 mounts store flat keys, and restore re-derives whichever
// shape the target mount needs.
export function archivePath(row: MountPathRow, byId: Map<string, MountPathRow>): string {
    const segment = (r: MountPathRow) => (r.trashedFrom ? trashStorageKey(r.id, r.name) : r.name);
    const segments = [segment(row)];
    for (const parent of ancestors(row, byId)) {
        if (parent.parentId === null) break; // the mount root contributes no segment
        segments.unshift(segment(parent));
    }
    return segments.join('/');
}

// What a flat-key backend (`local-key`, `s3`) stores a row's object under: `file`, falling back to
// the id for a row written before that column carried a value — Mount.getStorageKey's own rule.
// A path-based mount needs the whole ancestor chain instead (storageKeyOf).
export function flatStorageKey(row: Pick<MountPathRow, 'id' | 'file'>): string {
    return row.file || row.id;
}

// Mirrors Mount.resolveStoragePath / getStorageKey, resolved from the tree we already hold rather
// than one recursive-CTE query per file. Restore puts every file back at the key the restored mount
// looks for it under: one spelling of the rule for both directions.
export function storageKeyOf(row: MountPathRow, byId: Map<string, MountPathRow>, isPathBased: boolean): string {
    if (!isPathBased) return flatStorageKey(row);
    const segments = row.file ? [row.file] : [];
    for (const parent of ancestors(row, byId)) {
        if (parent.parentId === null) break;
        if (parent.file) segments.unshift(parent.file);
    }
    return segments.join('/');
}

// The databases the mount itself manages: a container's data.db/comments.db, and the versions/
// snapshots of one. Returns the container to lock while copying, or null for anything else — a
// user's own upload that happens to be SQLite must round-trip byte-identical.
export function managedDbContainer(row: MountPathRow, byId: Map<string, MountPathRow>): MountPathRow | null {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (!parent) return null;
    if (parent.name === VERSIONS_FOLDER_NAME) {
        const container = parent.parentId ? byId.get(parent.parentId) : undefined;
        return container && isDocumentType(container.type) ? container : null;
    }
    return CONTAINER_DB_NAMES.has(row.name) && isDocumentType(parent.type) ? parent : null;
}

// The rows of an archived metadata.db, in the shape every reader of one wants (verify, restore).
export function readMountPathRows(db: Database): MountPathRow[] {
    const columns = Object.values(MOUNT_PATH_COLUMNS)
        .map((column) => column.name)
        .join(', ');
    return db.query<MountPathRow, []>(`SELECT ${columns} FROM paths`).all();
}

// Where a row's parent chain ends when it does not end at a root row: at a parent the table does not hold, or in a
// cycle, where `ancestors` stops in silence. Null for a row that reaches the root.
function brokenChain(row: MountPathRow, byId: Map<string, MountPathRow>): string | null {
    let top = row;
    for (const parent of ancestors(row, byId)) top = parent;
    if (top.parentId === null) return null;
    return byId.has(top.parentId)
        ? 'sits in a parent cycle'
        : `reaches a parent (${top.parentId}) the table does not hold`;
}

// Every path a restore builds is a join of id, name and file: a `..` or a separator in one moves bytes out of the
// mount. The one separator a live table holds is a trash root's `file` on a path-based mount, which must be exactly
// trashPath's key.
function unusableParts(row: MountPathRow): string[] {
    const failures: string[] = [];
    if (!isUsableName(row.id)) failures.push(`path row "${row.id}" has an unusable id`);
    if (!isUsableName(row.name)) failures.push(`path row ${row.id} has an unusable name "${row.name}"`);
    // Empty is how a flat-key mount spells a folder row (Mount.buildFileValue).
    const trashKey = row.trashedFrom !== null && row.file === trashStorageKey(row.id, row.name);
    if (row.file !== '' && !trashKey && !isUsableName(row.file)) {
        failures.push(`path row ${row.id} has an unusable file "${row.file}"`);
    }
    return failures;
}

// The rows no path builder can place, by their chain or by a part a path cannot hold: the capture leaves them out of
// an archive, with what is inside them, and verify refuses an archive with one.
export function unreachableRows(rows: MountPathRow[]): { orphaned: MountPathRow[]; unusable: MountPathRow[] } {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const orphaned: MountPathRow[] = [];
    const unusable: MountPathRow[] = [];
    for (const row of rows) {
        if (unusableParts(row).length > 0) unusable.push(row);
        else if (brokenChain(row, byId) !== null) orphaned.push(row);
    }
    return { orphaned, unusable };
}

// An archived paths table arrived inside a file an admin uploaded, so a row no path can be built for refuses the
// archive whole, and so does a tree that does not end at the root.
export function checkArchivedPathRows(rows: MountPathRow[]): string[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const failures: string[] = [];
    for (const row of rows) {
        failures.push(...unusableParts(row));
        const broken = brokenChain(row, byId);
        if (broken) failures.push(`path row ${row.id} ${broken}`);
    }
    return failures;
}

// The same rule, read back from an archived metadata.db: which of a mount's archived files are
// Eigen's own databases. Verify needs it to know what it may open — a user's own SQLite upload is
// stored byte-identical, journal header and all, and opening it is not verify's business.
export function listManagedDatabases(rows: MountPathRow[]): ManagedArchiveDatabase[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found: ManagedArchiveDatabase[] = [];
    for (const row of rows) {
        if (row.type !== 'file') continue;
        const container = managedDbContainer(row, byId);
        if (!container) continue;
        // The container is the parent of a live data.db and the grandparent of a version snapshot.
        const isContainerData = container.id === row.parentId && row.name === CONTAINER_DATA_DB;
        found.push({
            path: archivePath(row, byId),
            isContainerData,
            containerType: container.type,
            config: configOf(row.name, container.type),
            row,
        });
    }
    return found;
}
