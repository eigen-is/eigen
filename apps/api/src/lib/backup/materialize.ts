import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseBackupAuthRows, parseBackupShares } from '@workspace/lib/validation';
import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { user as userTable } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { getAvatarsDir } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { ApiError, type DatabaseConfig, PATHS, type SchemaType } from '../core';
import { MOUNT_DB_CONFIG, PENDING_UPLOAD_KIND_VERSION } from '../mount/db-config';
import { buildStorageKey } from '../mount/helpers';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { AUTH_TABLES, ownerKeyOf, RESTORED_MEMBER_ROLE, RESTORED_USER_ROLE } from './auth-tables';
import { errnoOf } from './errors';
import { ARCHIVE_AUTH_FILE, ARCHIVE_AVATAR_DIR, ARCHIVE_SHARES_FILE, resolveInside, resolveMountDir } from './paths';
import { HOME_DATABASES } from './snapshot-home';
import { archivePath, listManagedDatabases, readMountPathRows, storageKeyOf } from './snapshot-mount';

// What a restore does to a home folder once it is in place: put every mount's files where that
// mount's own backend will look for them, judge what landed, and write back the identity the
// archive carries. The orchestration around it — the lock, the move-aside, the rollback — is in
// restore.ts.

// A restored database and the schema this build expects of it.
export type VersionedDatabase = { filePath: string; config: DatabaseConfig<SchemaType> };

// The backups folder may sit on another disk than the data root, and a rename across the two fails
// with EXDEV — so fall back to a copy.
export function movePath(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (errnoOf(error) !== 'EXDEV') throw error;
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

// What a database says about itself. Absent (a file with no __schema_version table) reads as 0, the
// same as ManagedDatabase's own "never migrated" answer. Read-write, like every open below it: a WAL
// database nobody is holding open has no -shm beside it, and a read-only open of one fails outright.
function schemaVersionOf(filePath: string): number {
    let db: Database | null = null;
    try {
        // Inside the try: a file this cannot even be opened on (EACCES, EIO) reads as unstamped, and
        // the quick_check right after it is what turns that into a named failure.
        db = new Database(filePath, { readwrite: true, create: false });
        const row = db.query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1').get();
        return row?.version ?? 0;
    } catch {
        return 0;
    } finally {
        db?.close();
    }
}

// Put one mount's files where the restored mount will look for them. The archive holds every file
// under `data/` by path (what a `local` mount stores natively), so every backend re-derives its own
// keys from the restored tree: a path-based mount its name chain, a `local-key` mount a flat key,
// and an `s3` mount stages the file with a pending upload so the existing UploadQueue drains it to
// the bucket with its normal retry and backoff — the user can work at once, and a flaky bucket makes
// the restore resumable by construction. Returns the container databases that stayed on local disk.
export function materializeMount(
    homeDir: string,
    summary: BackupManifest['mounts'][number],
    stamp: string,
): VersionedDatabase[] {
    // The id comes out of the archive's manifest. The parser holds it to the class a real mount id
    // uses, and this is the second lock on the same door: whatever it says, the folder it resolves
    // to has to be inside the home being restored.
    const mountDir = resolveMountDir(homeDir, summary.id);
    if (!mountDir) throw new ApiError(400, `The archive names a mount (${summary.id}) that is not in this home`);
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadataPath)) {
        throw new ApiError(400, `The archive promises mount ${summary.id} but carries no metadata.db for it`);
    }
    const isPathBased = summary.storageType === 'local';
    const isRemote = summary.storageType === 's3';
    // Only a remote mount gets pending rows written for it, and those name the column that carries
    // the kind of each staged copy (schema.ts, `isDatabase`). An archive from before that column
    // would take its DEFAULT and every restored plain file would later be dropped as a corrupt
    // staged copy — so refuse it here, and leave a local mount's older archive alone.
    const metadataVersion = schemaVersionOf(metadataPath);
    if (isRemote && metadataVersion < PENDING_UPLOAD_KIND_VERSION) {
        throw new ApiError(
            400,
            `Mount ${summary.id} was archived at metadata schema v${metadataVersion}, too old to restore ` +
                `(v${PENDING_UPLOAD_KIND_VERSION} or newer needed)`,
        );
    }

    const db = new Database(metadataPath);
    try {
        const rows = readMountPathRows(db);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const managed = listManagedDatabases(rows);
        // Every path below is built out of the archive's own paths table. Verify refuses a table
        // that could leave the mount at all (checkArchivedPathRows); this is the second lock on the
        // same door, one resolve per path, so no route into here can move a byte out of `data/`.
        const inData = (relPath: string): string => {
            const abs = resolveInside(dataDir, relPath);
            if (!abs) throw new ApiError(400, `Mount ${summary.id} names a path that leaves it: ${relPath}`);
            return abs;
        };
        // Every pending row names a staged copy on the source server that the archive does not carry.
        db.run('DELETE FROM pending_uploads');

        if (isPathBased) {
            // A folder carries no bytes, so an empty one has no archive entry — recreate them from
            // the table, or a later rename of one 404s.
            for (const row of rows) {
                if (row.type === 'file' || row.parentId === null) continue;
                fs.mkdirSync(inData(archivePath(row, byId)), { recursive: true });
            }
        }
        const stagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
        if (isRemote) fs.mkdirSync(stagingDir, { recursive: true });
        const enqueue = db.prepare(
            'INSERT INTO pending_uploads (storageKey, stagingPath, attempt, enqueuedAt, nextAttemptAt, isDatabase)' +
                ' VALUES (?, ?, 0, ?, ?, ?)',
        );
        const rekey = db.prepare('UPDATE paths SET file = ? WHERE id = ?');
        const managedPaths = new Set(managed.map((entry) => entry.path));
        const now = Date.now();
        for (const row of rows) {
            if (row.type !== 'file') continue;
            const archived = archivePath(row, byId);
            const source = inData(archived);
            // A remote mount's objects are the only ones a restore could write over: they are in a
            // bucket, not in the folder that moved aside. So every one of its rows gets a key of its
            // own, and the `.pre-restore-` copy keeps pointing at objects that still hold its bytes.
            // Before the missing-bytes check, not after: a row the archive carries nothing for must
            // not keep the key the copy references, or a late upload would land on an object it owns
            // (a fresh key with nothing behind it reads as absent, which is what that row is). The
            // row is this function's read model, so the new key goes into it and into the table.
            if (isRemote) {
                row.file = buildStorageKey(`${row.id}-r${stamp}`, row.name);
                rekey.run(row.file, row.id);
            }
            // A row whose storage object was already missing when the backup ran has no bytes here;
            // the restored home mirrors that absence rather than inventing an empty object.
            if (!fs.existsSync(source)) continue;
            const key = storageKeyOf(row, byId, isPathBased);
            if (isRemote) {
                const staged = randomUUID();
                movePath(source, path.join(stagingDir, staged));
                enqueue.run(key, staged, now, now, managedPaths.has(archived) ? 1 : 0);
                continue;
            }
            // Usually the same file on a path-based mount (`file` is the name), but migration v7
            // renamed the NAME of a deduplicated row and left its `file` alone, so the two differ
            // there — and the mount resolves reads through `file`. Nothing can be overwritten either
            // way: a local mount's bytes moved aside with the folder.
            const target = inData(key);
            if (target !== source) movePath(source, target);
        }
        enqueue.finalize();
        rekey.finalize();
        if (isRemote) {
            // An s3 mount's bytes belong in the bucket, and the queue holds every one of them in
            // staging until the PUT acks; the archive still has them all if that never happens.
            // Keeping the by-path tree as well would double the disk a restored remote mount costs.
            fs.rmSync(dataDir, { recursive: true, force: true });
            return [];
        }
        // What is left under data/ after a local-key move is the archive's by-path folders, which
        // that backend has no use for. A path-based mount keeps them: they are its layout.
        if (!isPathBased) pruneEmptyDirs(dataDir);
        return managed.map((entry) => ({
            filePath: inData(storageKeyOf(entry.row, byId, isPathBased)),
            config: entry.config,
        }));
    } finally {
        db.close();
    }
}

// Depth-first, directories only: a leftover file means the tree and the paths table disagree, and
// deleting it would be the restore losing bytes.
function pruneEmptyDirs(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        pruneEmptyDirs(child);
        if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
    }
}

// JSON.stringify wrote every timestamp column as an ISO string and Drizzle wants a Date back. Which
// columns those are comes from the schema itself, so a new better-auth column needs no edit here.
function reviveDates(row: Record<string, unknown>, table: SQLiteTable): void {
    for (const [name, column] of Object.entries(getTableColumns(table))) {
        const value = row[name];
        if (column.dataType !== 'date') continue;
        if (typeof value === 'string' || typeof value === 'number') row[name] = new Date(value);
    }
}

// Re-insert the identity the archive carries, for a user the server no longer has. A user that IS
// still here keeps every row it has: a restore puts a home's data back, it never rewrites who
// somebody is — and an id whose email no longer matches the archive is a different person.
export function restoreAuthRows(ownerId: string, manifest: BackupManifest, folder: string): void {
    const authPath = path.join(folder, ARCHIVE_AUTH_FILE);
    if (!fs.existsSync(authPath)) return;
    const db = getAuthDrizzleDb();

    const existing = db.select().from(userTable).where(eq(userTable.id, ownerId)).get();
    if (existing) {
        if (manifest.email && existing.email !== manifest.email) {
            throw new ApiError(409, `${ownerId} is now ${existing.email}; the archive holds ${manifest.email}`);
        }
        return;
    }

    const archive = parseBackupAuthRows(fs.readFileSync(authPath, 'utf8'));
    if (!archive) throw new ApiError(400, `${ARCHIVE_AUTH_FILE} is not a set of users3.db rows`);

    // The identity itself: exactly one user row, this owner's id, the email the manifest was written
    // with. Anything else and not a row goes in — an archive carrying a second user row is carrying
    // somebody it invented.
    const identity = (archive['user'] ?? []).filter((row) => row['id'] === ownerId);
    if (identity.length !== 1 || (manifest.email && identity[0]['email'] !== manifest.email)) {
        throw new ApiError(
            400,
            `${ARCHIVE_AUTH_FILE} does not hold exactly one ${ownerId} row for ${manifest.email ?? 'this home'}`,
        );
    }
    const orgId = getPublicConfig().orgId;
    const drop = (table: string, reason: string): void => {
        console.warn(`[backup] ${ownerId}: a ${table} row was not restored — ${reason}`);
    };

    // One transaction for the whole identity: a clash on a later row would otherwise leave a user
    // that exists but cannot sign in — and the next attempt would take the branch above and return.
    db.transaction((tx) => {
        for (const spec of AUTH_TABLES) {
            const ownerKey = ownerKeyOf(spec);
            let membership = false;
            for (const row of archive[spec.key] ?? []) {
                // Every row names its own owner, and only this home's own come back.
                if (row[ownerKey] !== ownerId) {
                    drop(spec.key, `it belongs to ${String(row[ownerKey])}`);
                    continue;
                }
                if (spec.key === 'user') row['role'] = RESTORED_USER_ROLE;
                if (spec.key === 'member') {
                    // A user belongs to this server's one organization, whichever one the archive
                    // named — so a second row would be a second membership of the same org.
                    if (membership) {
                        drop(spec.key, 'this server gives a user one organization');
                        continue;
                    }
                    membership = true;
                    row['organizationId'] = orgId;
                    row['role'] = RESTORED_MEMBER_ROLE;
                }
                // `team_member` needs no rewrite of its own: it carries no role, and the parent check
                // below is what keeps a membership of a team this server does not have out.
                if (spec.parent) {
                    // A membership whose organization or team is gone would be an orphan, and
                    // better-auth's listMembers chokes on those (see user/delete-user.ts).
                    const parentId = row[spec.parent.column];
                    const found =
                        typeof parentId === 'string' &&
                        tx
                            .select({ id: spec.parent.id })
                            .from(spec.parent.table)
                            .where(eq(spec.parent.id, parentId))
                            .get();
                    if (!found) {
                        drop(spec.key, `its parent ${String(parentId)} is gone`);
                        continue;
                    }
                }
                reviveDates(row, spec.table);
                tx.insert(spec.table).values(row).run();
            }
        }
    });
}

// Insert missing only: a registry row that is already there describes a live share.
export async function restoreShares(ownerId: string, folder: string): Promise<void> {
    const sharesPath = path.join(folder, ARCHIVE_SHARES_FILE);
    if (!fs.existsSync(sharesPath)) return;
    const rows = parseBackupShares(fs.readFileSync(sharesPath, 'utf8'));
    if (!rows) throw new ApiError(400, `${ARCHIVE_SHARES_FILE} is not a set of share-registry rows`);
    const db = await getEigenDb();
    for (const row of rows) {
        db.insert(shareRegistry)
            .values({ fromUserId: ownerId, targetIdentifier: row.targetIdentifier })
            .onConflictDoNothing()
            .run();
    }
}

// The avatar is server data, not home data: put it back only where the server has none, so a picture
// the user changed after the backup is not quietly reverted. The name comes out of the archive and
// lands in the server-wide avatars folder, so it has to BE this user's: `{ownerId}.{ext}` and
// nothing else, or a hostile archive would plant a picture for somebody who has none.
export async function restoreAvatar(ownerId: string, folder: string): Promise<void> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
        if (path.parse(name).name !== ownerId) {
            console.warn(`[backup] ${ownerId}: ${name} in the archive is not this user's avatar, not restored`);
            continue;
        }
        const target = path.join(getAvatarsDir(), name);
        if (fs.existsSync(target)) continue;
        await Bun.write(target, Bun.file(path.join(avatarDir, name)));
    }
}

// What landed has to be a database this server can still open: SQLite's own verdict on the bytes,
// and the schema stamp against the config that will open them. A database from a NEWER server passes
// quick_check and is then refused by ManagedDatabase's forward-version guard — which fails the whole
// home on the next load, long after the job said it was done. The home is evicted and the restoring
// mark is still set, so this is the one place a live home's databases are opened directly.
export function checkRestoredDatabases(
    homeDir: string,
    mountIds: string[],
    containerDatabases: VersionedDatabase[],
): void {
    const targets: VersionedDatabase[] = HOME_DATABASES.map(([config, relPath]) => ({
        filePath: path.join(homeDir, relPath),
        config,
    }));
    for (const mountId of mountIds) {
        const mountDir = resolveMountDir(homeDir, mountId);
        if (!mountDir) throw new ApiError(400, `${mountId} is not a mount of this home`);
        targets.push({ filePath: path.join(mountDir, PATHS.DRIVE.METADATA_DB), config: MOUNT_DB_CONFIG });
    }
    // An s3 mount's container databases are staged copies on their way to the bucket, not files at a
    // knowable path; verify read every one of them in the folder this restore unpacked minutes ago.
    targets.push(...containerDatabases);

    for (const target of targets) {
        if (!fs.existsSync(target.filePath)) continue;
        const version = schemaVersionOf(target.filePath);
        if (version > target.config.currentVersion) {
            throw new ApiError(
                400,
                `${target.filePath} is at ${target.config.name} schema v${version}, newer than this server ` +
                    `supports (v${target.config.currentVersion}) — restore it on a server at least as new`,
            );
        }
        const db = new Database(target.filePath, { readwrite: true, create: false });
        try {
            const row = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
            if (row?.quick_check !== 'ok') {
                throw new ApiError(
                    500,
                    `${target.filePath} did not survive the restore: ${row?.quick_check ?? 'no answer'}`,
                );
            }
        } finally {
            db.close();
        }
    }
}

// The managed databases a home folder holds, for a restore with no manifest to enumerate them
// from: every mount's paths table, keyed the way that mount's own backend keys its objects. A
// remote mount's are in its bucket, so the path derived for one does not exist and the check skips
// it — exactly what materializeMount returns for the same mount.
export function containerDatabasesIn(homeDir: string, mountIds: string[]): VersionedDatabase[] {
    const found: VersionedDatabase[] = [];
    for (const mountId of mountIds) {
        const mountDir = resolveMountDir(homeDir, mountId);
        if (!mountDir) throw new ApiError(400, `${mountId} is not a mount of this home`);
        const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        const db = new Database(metadataPath, { readwrite: true, create: false });
        try {
            const rows = readMountPathRows(db);
            const byId = new Map(rows.map((row) => [row.id, row]));
            // A folder row carries its own name as `file` on a path-based mount and nothing at all on
            // a flat-key one (Mount.buildFileValue) — which is what tells the two layouts apart with
            // no manifest to ask. A mount with no folders has no containers either.
            const isPathBased = rows.some((row) => row.type !== 'file' && row.parentId !== null && row.file !== '');
            for (const entry of listManagedDatabases(rows)) {
                found.push({
                    filePath: path.join(dataDir, storageKeyOf(entry.row, byId, isPathBased)),
                    config: entry.config,
                });
            }
        } finally {
            db.close();
        }
    }
    return found;
}
