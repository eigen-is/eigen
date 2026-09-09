import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { parseBackupAuthRows, parseBackupManifest, parseBackupShares } from '@workspace/lib/validation';
import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { user as userTable } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { closeCollabConnectionsForHome } from '../collab/connections';
import { getAvatarsDir, getTeamDataPath, getUserHomePath } from '../config/paths';
import { ApiError, type DatabaseConfig, PATHS, type SchemaType } from '../core';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { MOUNT_DB_CONFIG, PENDING_UPLOAD_KIND_VERSION } from '../mount/db-config';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { getUserById } from '../user/user';
import { extractArtifact } from './archive';
import { AUTH_TABLES } from './auth-tables';
import {
    ARCHIVE_AUTH_FILE,
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_SHARES_FILE,
    buildHomeFolderName,
    buildStamp,
    FAILED_RESTORE_SUFFIX,
    getBackupStagingDir,
    getBackupsDir,
    PRE_RESTORE_SUFFIX,
    parseArtifactName,
} from './paths';
import { HOME_DATABASES, type SnapshotProgress } from './snapshot-home';
import { archivePath, listManagedDatabases, readMountPathRows, storageKeyOf } from './snapshot-mount';
import { verifyFolder } from './verify';

// A restored database and the schema this build expects of it.
type VersionedDatabase = { filePath: string; config: DatabaseConfig<SchemaType> };

// Where this owner's home folder lives. Org homes hold no databases and guest homes are disposable
// (guest-cleanup deletes them), so neither is backed up and neither can be restored.
export async function resolveHomeDir(ownerId: string): Promise<string> {
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') return getTeamDataPath(owner.id);
    if (owner.type !== 'user') throw new ApiError(400, `Cannot restore a ${owner.type} home`);
    const existing = await getUserById(owner.id);
    if (existing?.role === 'guest') throw new ApiError(400, 'Guest homes are not backed up');
    return getUserHomePath(owner.id);
}

// The backups folder may sit on another disk than the data root, and a rename across the two fails
// with EXDEV — so fall back to a copy.
function movePath(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

// Two restores of one home within the same second would otherwise pick the same safety-copy name,
// and renaming onto an existing folder fails (ENOTEMPTY) — with the home already moved aside.
function freeName(candidate: string): string {
    let free = candidate;
    for (let n = 2; fs.existsSync(free); n++) free = `${candidate}-${n}`;
    return free;
}

// What a database says about itself. Absent (a file with no __schema_version table) reads as 0, the
// same as ManagedDatabase's own "never migrated" answer.
function schemaVersionOf(filePath: string): number {
    const db = new Database(filePath, { readonly: true });
    try {
        const row = db.query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1').get();
        return row?.version ?? 0;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

// Put one mount's files where the restored mount will look for them. The archive holds every file
// under `data/` by path (what a `local` mount stores natively), so every backend re-derives its own
// keys from the restored tree: a path-based mount its name chain, a `local-key` mount its flat key,
// and an `s3` mount stages the file with a pending upload so the existing UploadQueue drains it to
// the bucket with its normal retry and backoff — the user can work at once, and a flaky bucket makes
// the restore resumable by construction. Returns the container databases that stayed on local disk.
function materializeMount(homeDir: string, summary: BackupManifest['mounts'][number]): VersionedDatabase[] {
    const mountDir = path.join(homeDir, PATHS.DRIVE.ROOT, summary.id);
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
        // Every pending row names a staged copy on the source server that the archive does not carry.
        db.run('DELETE FROM pending_uploads');

        if (isPathBased) {
            // A folder carries no bytes, so an empty one has no archive entry — recreate them from
            // the table, or a later rename of one 404s.
            for (const row of rows) {
                if (row.type === 'file' || row.parentId === null) continue;
                fs.mkdirSync(path.join(dataDir, archivePath(row, byId)), { recursive: true });
            }
        }
        const stagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
        if (isRemote) fs.mkdirSync(stagingDir, { recursive: true });
        const enqueue = db.prepare(
            'INSERT INTO pending_uploads (storageKey, stagingPath, attempt, enqueuedAt, nextAttemptAt, isDatabase)' +
                ' VALUES (?, ?, 0, ?, ?, ?)',
        );
        const managedPaths = new Set(managed.map((entry) => entry.path));
        const now = Date.now();
        for (const row of rows) {
            if (row.type !== 'file') continue;
            const archived = archivePath(row, byId);
            const source = path.join(dataDir, archived);
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
            // there — and the mount resolves reads through `file`.
            const target = path.join(dataDir, key);
            if (target !== source) movePath(source, target);
        }
        enqueue.finalize();
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
            filePath: path.join(dataDir, storageKeyOf(entry.row, byId, isPathBased)),
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
function restoreAuthRows(ownerId: string, manifest: BackupManifest, folder: string): void {
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
    // One transaction for the whole identity: a clash on a later row would otherwise leave a user
    // that exists but cannot sign in — and the next attempt would take the branch above and return.
    db.transaction((tx) => {
        for (const spec of AUTH_TABLES) {
            for (const row of archive[spec.key] ?? []) {
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
                        console.warn(
                            `[backup] ${ownerId}: ${spec.key} parent ${String(parentId)} is gone, not restored`,
                        );
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
async function restoreShares(ownerId: string, folder: string): Promise<void> {
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
// the user changed after the backup is not quietly reverted.
async function restoreAvatar(folder: string): Promise<void> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
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
function checkRestoredDatabases(
    homeDir: string,
    manifest: BackupManifest,
    containerDatabases: VersionedDatabase[],
): void {
    const targets: VersionedDatabase[] = HOME_DATABASES.map(([config, relPath]) => ({
        filePath: path.join(homeDir, relPath),
        config,
    }));
    for (const summary of manifest.mounts) {
        targets.push({
            filePath: path.join(homeDir, PATHS.DRIVE.ROOT, summary.id, PATHS.DRIVE.METADATA_DB),
            config: MOUNT_DB_CONFIG,
        });
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
        const db = new Database(target.filePath, { readonly: true });
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

// Replaces one home with the copy inside an artifact. Nothing is ever deleted: the home as it stands
// is renamed aside as `{id}.pre-restore-{ts}`, and a failure after that point leaves the incomplete
// folder as `{id}.failed-restore-{ts}` and puts the original back. The home is refused on every
// surface for the duration (markHomeRestoring, which is also the lock against a second restore) and
// its collab sockets are told to reload; the first load after the mark clears runs migrations,
// reconciles contacts and refreshes shared-with-me.
export async function restoreHome(
    artifactName: string,
    ownerId: string,
    jobId: string,
    onProgress?: SnapshotProgress,
): Promise<void> {
    if (!parseArtifactName(artifactName)) {
        throw new ApiError(400, `${artifactName} is not a backup artifact name`);
    }
    const artifactPath = path.join(getBackupsDir(), artifactName);
    if (!fs.existsSync(artifactPath)) {
        throw new ApiError(404, `${artifactName} is not in the backups folder`);
    }
    const homeDir = await resolveHomeDir(ownerId);

    // 1 — lock. Throws when another restore of this home holds it, before anything below runs.
    markHomeRestoring(ownerId);
    try {
        // 2 — unpack into this job's staging folder and judge the archive before anything is touched.
        const unpackDir = path.join(getBackupStagingDir(jobId), 'restore');
        fs.rmSync(unpackDir, { recursive: true, force: true });
        onProgress?.('extract', 0, 1);
        await extractArtifact(artifactPath, unpackDir);
        onProgress?.('extract', 1, 1);
        const folder = path.join(unpackDir, buildHomeFolderName(ownerId));
        if (!fs.existsSync(folder)) {
            throw new ApiError(400, `${artifactName} is a backup of another home`);
        }
        const manifest = parseBackupManifest(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        if (!manifest) throw new ApiError(400, `${artifactName} carries no version 1 backup manifest`);
        if (manifest.ownerId !== ownerId) {
            throw new ApiError(400, `${artifactName} is a backup of another home (${manifest.ownerId})`);
        }
        const verified = await verifyFolder(folder, onProgress);
        if (verified.status !== 'verified') {
            // The whole list is in the record; three is enough for a message.
            throw new ApiError(400, `${artifactName} did not verify: ${verified.failures.slice(0, 3).join('; ')}`);
        }

        // 3 — take the home away from everyone holding it. Sessions are untouched: the user stays
        // signed in, every request just meets the 503 until the mark clears.
        closeCollabConnectionsForHome(ownerId);
        await evictHome(ownerId);

        // 4 — move the current home aside. There is none on a restore after the user was deleted.
        const stamp = buildStamp(new Date());
        let movedAside: string | null = null;
        if (fs.existsSync(homeDir)) {
            movedAside = freeName(`${homeDir}${PRE_RESTORE_SUFFIX}${stamp}`);
            fs.renameSync(homeDir, movedAside);
        }

        try {
            // 5 — the archive's `home/` IS the home folder, one for one.
            onProgress?.('home files', 0, 1);
            movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
            onProgress?.('home files', 1, 1);
            const containerDatabases: VersionedDatabase[] = [];
            for (const [index, summary] of manifest.mounts.entries()) {
                containerDatabases.push(...materializeMount(homeDir, summary));
                onProgress?.('mounts', index + 1, manifest.mounts.length);
            }

            // 6 — what landed is still a database this server can open. Before the identity write,
            // not after it (the spec has these the other way around): the rollback moves folders, and
            // nothing takes a users3.db row back. A restore of a deleted user that failed this check
            // after re-inserting would leave a user who can sign in with no home — and whose retry
            // would find that user and skip the insert for good.
            checkRestoredDatabases(homeDir, manifest, containerDatabases);

            // 7 — the rows that live outside the home folder (users only).
            restoreAuthRows(ownerId, manifest, folder);
            await restoreShares(ownerId, folder);
            await restoreAvatar(folder);
        } catch (error) {
            // Nothing is deleted, ever: the half-restored folder keeps a name of its own and the home
            // as it was goes back. A failure while putting it back must not hide the original one.
            try {
                if (fs.existsSync(homeDir)) {
                    fs.renameSync(homeDir, freeName(`${homeDir}${FAILED_RESTORE_SUFFIX}${stamp}`));
                }
                if (movedAside) fs.renameSync(movedAside, homeDir);
            } catch (rollbackError) {
                console.error(`[backup] could not put ${ownerId}'s home back after a failed restore:`, rollbackError);
            }
            throw error;
        }

        try {
            fs.rmSync(unpackDir, { recursive: true, force: true });
        } catch (error) {
            // The restore is done; a staging folder left behind is the boot-time wipe's problem.
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
        }
        onProgress?.('done', 1, 1);
    } finally {
        // 8 — unlock. Set.delete cannot throw, so this never masks the failure that brought us here.
        clearHomeRestoring(ownerId);
    }
}
