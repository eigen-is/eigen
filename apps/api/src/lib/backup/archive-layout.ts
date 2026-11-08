// What a home archive holds, read without a live home: the home databases, and a mount's paths table turned into
// archive paths and storage keys, with the checks an uploaded table must pass first. The backup steps share it, such
// as capture, verify and restore. Nothing it imports opens a file, so ./eigen restore can stage an archive with it
// while the API runs on the same data/.

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
import { isReservedName, isUsableName, MAX_FOLDER_DEPTH, trashStorageKey } from '../mount/names';
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

// The home-relative paths of the databases above. Verify reads them back to know which archived .db
// files are Eigen's own.
export const HOME_DATABASE_PATHS = new Set(HOME_DATABASES.map(([, relPath]) => relPath));

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

// Where each row's bytes go inside the archive: the storage key it would have on a `local` mount. That is the name
// chain from the root, with a trash root at `.trash/{id}.{ext}` as trashPath spells it. Deriving it from metadata.db
// instead of the mount's own keys is what makes the archive storage-independent: local-key and s3 mounts store flat
// keys, and restore re-derives whichever shape the target mount needs. Each folder's path is built once.
export function archivePaths(rows: readonly MountPathRow[]): (row: MountPathRow) => string {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const built = new Map<string, string>();
    const segment = (row: MountPathRow) => (row.trashedFrom ? trashStorageKey(row.id, row.name) : row.name);
    return (row) => {
        const unbuilt: MountPathRow[] = [];
        let top: MountPathRow | undefined = row;
        // Marked before its path is known, so a walk ends on a parent cycle too. The root contributes no segment.
        while (top && top.parentId !== null && !built.has(top.id)) {
            built.set(top.id, '');
            unbuilt.push(top);
            top = byId.get(top.parentId);
        }
        let prefix = top ? (built.get(top.id) ?? '') : '';
        for (const passed of unbuilt.reverse()) {
            prefix = prefix ? `${prefix}/${segment(passed)}` : segment(passed);
            built.set(passed.id, prefix);
        }
        return prefix;
    };
}

// Mirrors Mount.findStorageKey, resolved from the tree already held rather than one recursive-CTE
// query per file. Restore puts every file back at the key the restored mount looks for it under.
// A flat-key backend (`local-key`, `s3`) stores a file's object under its `file`.
export function storageKeyOf(row: MountPathRow, byId: ReadonlyMap<string, MountPathRow>, isPathBased: boolean): string {
    if (!isPathBased) return row.file;
    const segments = row.file ? [row.file] : [];
    // A walk that meets a row twice stops, as a parent cycle would otherwise spin forever on an untrusted table.
    const seen = new Set<string>([row.id]);
    let parent = row.parentId === null ? undefined : byId.get(row.parentId);
    while (parent && parent.parentId !== null && !seen.has(parent.id)) {
        seen.add(parent.id);
        if (parent.file) segments.unshift(parent.file);
        parent = byId.get(parent.parentId);
    }
    return segments.join('/');
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

// The rows no path builder can place, by their chain or by a part a path cannot hold: the capture leaves them out of
// an archive, with what is inside them, and verify refuses an archive with one.
export function unreachableRows(rows: readonly MountPathRow[]): { orphaned: MountPathRow[]; unusable: MountPathRow[] } {
    const chains = parentChains(rows);
    const orphaned: MountPathRow[] = [];
    const unusable: MountPathRow[] = [];
    for (const row of rows) {
        if (unusableParts(row).length > 0) unusable.push(row);
        else if (typeof chains.get(row.id) === 'string') orphaned.push(row);
    }
    return { orphaned, unusable };
}

// An archived paths table arrived inside a file an admin uploaded, so a row no path can be built for refuses the
// archive whole, and so do a tree that does not end at the root or sits deeper than a live drive allows, and a trash
// root whose delete would wait on itself. Verify runs it on the event loop, so every check is linear in the rows.
export function checkArchivedPathRows(rows: readonly MountPathRow[]): string[] {
    const chains = parentChains(rows);
    const failures: string[] = [];
    for (const row of rows) {
        failures.push(...unusableParts(row));
        const chain = chains.get(row.id);
        if (typeof chain === 'string') failures.push(`path row ${row.id} ${chain}`);
        else if (chain !== undefined && chain > MAX_FOLDER_DEPTH) {
            failures.push(`path row ${row.id} sits ${chain} levels deep, past the ${MAX_FOLDER_DEPTH} a drive allows`);
        }
    }
    const looped = failures.length === 0 && trashedFromInsideItself(rows);
    if (looped) failures.push(`path row ${looped.id} was trashed from inside itself`);
    return failures;
}

// The upload queue joins a pending row's stagingPath onto the mount's staging folder and sends the bucket that file, so
// a row in an uploaded table that names a path would send it any file of this host.
export function checkArchivedPendingUploads(db: Database): string[] {
    return db
        .query<{ storageKey: string; stagingPath: string }, []>('SELECT storageKey, stagingPath FROM pending_uploads')
        .all()
        .filter(({ stagingPath }) => !isUsableName(stagingPath))
        .map(
            ({ storageKey, stagingPath }) =>
                `pending upload "${storageKey}" has an unusable staged copy "${stagingPath}"`,
        );
}

// Each row's depth below the root, the root's 0, or where its parent chain ends when it does not reach the root: at
// a parent the table does not hold, or in a cycle. A walk stops at the first row it has a verdict for, and the rows
// it passed take theirs from it.
function parentChains(rows: readonly MountPathRow[]): Map<string, string | number> {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const verdicts = new Map<string, string | number>();
    for (const row of rows) {
        const walked = new Set<MountPathRow>();
        let current = row;
        // The verdict of the row above the last one walked, so the root's missing parent sits at -1.
        let verdict = verdicts.get(row.id);
        while (verdict === undefined && !walked.has(current)) {
            walked.add(current);
            const parent = current.parentId === null ? undefined : byId.get(current.parentId);
            if (current.parentId === null) verdict = -1;
            else if (!parent) verdict = `reaches a parent (${current.parentId}) the table does not hold`;
            else {
                current = parent;
                verdict = verdicts.get(parent.id);
            }
        }
        const ends = verdict ?? 'sits in a parent cycle';
        let below = walked.size;
        for (const passed of walked) verdicts.set(passed.id, typeof ends === 'number' ? ends + below-- : ends);
    }
    return verdicts;
}

// A trash root trashed from inside itself, directly or through other trash roots, whose permanent delete would wait on
// its own lock. A row links to its parent, and a trash root to its original folder too. Once every parent chain ends
// at the root, a loop among those links runs through such a root, and a depth-first walk on a stack of its own finds
// one: a row's complement on the stack marks it done once everything it links to is.
function trashedFromInsideItself(rows: readonly MountPathRow[]): MountPathRow | undefined {
    const position = new Map(rows.map((row, at) => [row.id, at]));
    // 0 unseen, 1 on the walk, 2 done.
    const state = new Uint8Array(rows.length);
    const walk: number[] = [];
    for (let start = 0; start < rows.length; start++) {
        const stack = [start];
        for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
            if (at < 0) {
                state[~at] = 2;
                walk.pop();
                continue;
            }
            if (state[at] !== 0) continue;
            state[at] = 1;
            walk.push(at);
            stack.push(~at);
            for (const id of [rows[at].parentId, rows[at].trashedFrom]) {
                const to = id === null ? undefined : position.get(id);
                if (to === undefined) continue;
                if (state[to] === 0) stack.push(to);
                else if (state[to] === 1) {
                    const loop = walk.slice(walk.indexOf(to)).map((onLoop) => rows[onLoop]);
                    return loop.find((row, step) => row.trashedFrom === loop[(step + 1) % loop.length].id);
                }
            }
        }
    }
    return undefined;
}

// Every path a restore builds is a join of id, name and file: a `..` or a separator in one moves bytes out of the
// mount, and a reserved name or file is the trash folder itself on `local`. The one separator a live table holds is
// a trash root's `file` on a path-based mount, which must be exactly trashPath's key.
function unusableParts(row: MountPathRow): string[] {
    const failures: string[] = [];
    if (!isUsableName(row.id)) failures.push(`path row "${row.id}" has an unusable id`);
    if (!isUsableName(row.name)) failures.push(`path row ${row.id} has an unusable name "${row.name}"`);
    if (isReservedName(row.name)) failures.push(`path row ${row.id} has a reserved name "${row.name}"`);
    if (isReservedName(row.file)) failures.push(`path row ${row.id} has a reserved file "${row.file}"`);
    // Empty is how a flat-key mount spells a folder row (Mount.createFolder). A file always has one, its object's key.
    const flatFolder = row.type !== 'file' && row.file === '';
    const trashKey = row.trashedFrom !== null && row.file === trashStorageKey(row.id, row.name);
    if (!flatFolder && !trashKey && !isUsableName(row.file)) {
        failures.push(`path row ${row.id} has an unusable file "${row.file}"`);
    }
    return failures;
}

// Which of a mount's archived files are Eigen's own databases, by managedDbContainer's rule. Verify needs
// it to know what it may open: a user's own SQLite upload is stored byte-identical, journal header and
// all, and opening it is not verify's business.
export function listManagedDatabases(rows: readonly MountPathRow[]): ManagedArchiveDatabase[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const archivePath = archivePaths(rows);
    const found: ManagedArchiveDatabase[] = [];
    for (const row of rows) {
        if (row.type !== 'file') continue;
        const container = managedDbContainer(row, byId);
        if (!container) continue;
        // The container is the parent of a live data.db and the grandparent of a version snapshot.
        const isContainerData = container.id === row.parentId && row.name === CONTAINER_DATA_DB;
        found.push({
            path: archivePath(row),
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
