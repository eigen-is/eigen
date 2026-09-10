import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import {
    parseBackupArtifactName,
    parseBackupAuthRows,
    parseBackupManifest,
    parseBackupShares,
} from '@workspace/lib/validation';
import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { user as userTable } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { closeCollabConnectionsForHome } from '../collab/connections';
import { getAvatarsDir } from '../config/paths';
import { ApiError, type DatabaseConfig, PATHS, type SchemaType } from '../core';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { MOUNT_DB_CONFIG, PENDING_UPLOAD_KIND_VERSION } from '../mount/db-config';
import { buildStorageKey } from '../mount/helpers';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { extractArtifact } from './archive';
import { forgetSafetyCopySize, resolveSafetyCopy } from './artifacts';
import { AUTH_TABLES } from './auth-tables';
import {
    ARCHIVE_AUTH_FILE,
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_HOME_DIR,
    ARCHIVE_SHARES_FILE,
    backupsDirPath,
    buildHomeFolderName,
    buildSafetyCopyName,
    buildStamp,
    getBackupStagingDir,
    getBackupsDir,
    parseSafetyCopyName,
    resolveHomeDir,
    resolveMountDir,
    wipeBackupStagingDir,
} from './paths';
import { HOME_DATABASES, type SnapshotProgress } from './snapshot-home';
import { archivePath, listManagedDatabases, readMountPathRows, storageKeyOf } from './snapshot-mount';
import { verifyFolder } from './verify';

// A restored database and the schema this build expects of it.
type VersionedDatabase = { filePath: string; config: DatabaseConfig<SchemaType> };

// The note a restore leaves in its staging folder while the home folder is not where it belongs.
// Written before the move-aside, removed when the mark clears, read once at the next boot.
const RESTORING_MARKER = 'restoring.json';
// Written beside it the moment the install is done, before the mark clears. A marker without this
// beside it means the process died with a home folder that is somewhere between the two states.
const RESTORE_COMPLETE_MARKER = 'restore-complete.json';
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string };

function restoringMarkerPath(jobId: string): string {
    return path.join(getBackupStagingDir(jobId), RESTORING_MARKER);
}

function writeRestoringMarker(jobId: string, marker: RestoringMarker): void {
    fs.writeFileSync(restoringMarkerPath(jobId), JSON.stringify(marker));
}

function markRestoreComplete(jobId: string): void {
    fs.writeFileSync(
        path.join(getBackupStagingDir(jobId), RESTORE_COMPLETE_MARKER),
        JSON.stringify({ completedAt: new Date().toISOString() }),
    );
}

// The marker survived a crash and names two paths this then renames, so it is read as untrusted
// input: the name has to be a pre-restore copy of exactly the home folder it claims.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    if (!fs.existsSync(markerPath)) return null;
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    if (!('ownerId' in value) || !('homeDir' in value) || !('preRestoreName' in value)) return null;
    const { ownerId, homeDir, preRestoreName } = value;
    if (typeof ownerId !== 'string' || typeof homeDir !== 'string' || typeof preRestoreName !== 'string') return null;
    const parsed = parseSafetyCopyName(preRestoreName);
    if (parsed?.kind !== 'pre-restore' || parsed.homeName !== path.basename(homeDir)) return null;
    return { ownerId, homeDir, preRestoreName };
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

// Two restores of one home within the same second must not land on one stamp: the second would
// rename onto an existing safety copy (ENOTEMPTY, with the home already moved aside) AND hand a
// flat-key mount the fresh storage keys the first restore just wrote (see materializeMount).
function freeStamp(homeDir: string, at: Date): string {
    const base = buildStamp(at);
    let stamp = base;
    for (
        let n = 2;
        fs.existsSync(buildSafetyCopyName(homeDir, 'pre-restore', stamp)) ||
        fs.existsSync(buildSafetyCopyName(homeDir, 'failed-restore', stamp));
        n++
    ) {
        stamp = `${base}-${n}`;
    }
    return stamp;
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
function materializeMount(
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
        const rekey = db.prepare('UPDATE paths SET file = ? WHERE id = ?');
        const managedPaths = new Set(managed.map((entry) => entry.path));
        const now = Date.now();
        for (const row of rows) {
            if (row.type !== 'file') continue;
            const archived = archivePath(row, byId);
            const source = path.join(dataDir, archived);
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
            const target = path.join(dataDir, key);
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
// the user changed after the backup is not quietly reverted. The name comes out of the archive and
// lands in the server-wide avatars folder, so it has to BE this user's: `{ownerId}.{ext}` and
// nothing else, or a hostile archive would plant a picture for somebody who has none.
async function restoreAvatar(ownerId: string, folder: string): Promise<void> {
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
function checkRestoredDatabases(homeDir: string, mountIds: string[], containerDatabases: VersionedDatabase[]): void {
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
function containerDatabasesIn(homeDir: string, mountIds: string[]): VersionedDatabase[] {
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

// A safety copy of a home whose owner is gone is a delete candidate, not a restore: the folder on
// its own leaves a home nobody can sign in to. Restoring a deleted user goes through an artifact,
// which carries their auth rows with it.
async function requireOwnerExists(ownerId: string): Promise<void> {
    const owner = parseOwnerId(ownerId);
    const found = owner.type === 'team' ? await getTeam(owner.id) : await getUserById(owner.id);
    if (!found) throw new ApiError(404, `${ownerId} no longer exists`);
}

// What a restore does once the home is out of everyone's hands and its folder is aside: put the new
// one at `homeDir`. Returned by the step that prepared it, so whatever it needs is a closure over
// the work that judged it.
type InstallHome = (stamp: string) => Promise<void>;

// The moves every restore is made of, in one place: take the home away from everyone holding it,
// put the folder as it stands aside as a safety copy, install the replacement, and on any failure
// put both folders back. `prepare` runs under the mark, before a byte is touched. `parkOnFailure`
// names where the folder in place goes if the install throws. Nothing is ever deleted, and the
// marker written here is the only thing that tells the next boot an interrupted restore happened —
// one writer, so recoverInterruptedRestores covers every kind of restore.
async function replaceHomeFolder(
    ownerId: string,
    homeDir: string,
    jobId: string,
    prepare: () => Promise<InstallHome>,
    parkOnFailure: (stamp: string) => string,
): Promise<void> {
    // The lock: throws when another restore of this home holds it, before anything below runs.
    markHomeRestoring(ownerId);
    try {
        const install = await prepare();

        // Sessions are untouched: the user stays signed in, every request just meets the 503 until
        // the mark clears.
        closeCollabConnectionsForHome(ownerId);
        await evictHome(ownerId);

        // There is no home folder to move aside on a restore after the user was deleted.
        const stamp = freeStamp(homeDir, new Date());
        let movedAside: string | null = null;
        if (fs.existsSync(homeDir)) {
            movedAside = buildSafetyCopyName(homeDir, 'pre-restore', stamp);
            // A process killed between here and the install leaves the user with no home folder, and
            // only this note tells the next boot which folder to put back — the folder's presence
            // alone means nothing (a deleted user's safety copies outlive them).
            writeRestoringMarker(jobId, { ownerId, homeDir, preRestoreName: path.basename(movedAside) });
            fs.renameSync(homeDir, movedAside);
        }

        try {
            await install(stamp);
            // The home folder is whole from here: everything after this only lets go of it. A crash
            // before this line leaves a half-written folder that only the next boot can judge, and
            // the absence of this note is what tells it so.
            if (movedAside) markRestoreComplete(jobId);
        } catch (error) {
            // Nothing is deleted, ever: the folder in place keeps a name of its own and the home as
            // it was goes back. A failure while putting it back must not hide the original one.
            try {
                if (fs.existsSync(homeDir)) fs.renameSync(homeDir, parkOnFailure(stamp));
                if (movedAside) fs.renameSync(movedAside, homeDir);
            } catch (rollbackError) {
                console.error(`[backup] could not put ${ownerId}'s home back after a failed restore:`, rollbackError);
            }
            throw error;
        }
    } finally {
        // Whatever happened above is over, and the rollback put the home back itself. Neither call
        // may throw over the failure that brought us here.
        clearHomeRestoring(ownerId);
        try {
            wipeBackupStagingDir(jobId);
        } catch (error) {
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
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
    if (!parseBackupArtifactName(artifactName)) {
        throw new ApiError(400, `${artifactName} is not a backup artifact name`);
    }
    const artifactPath = path.join(getBackupsDir(), artifactName);
    if (!fs.existsSync(artifactPath)) {
        throw new ApiError(404, `${artifactName} is not in the backups folder`);
    }
    const homeDir = await resolveHomeDir(ownerId);

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        async () => {
            // Unpack into this job's staging folder and judge the archive before anything is touched.
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

            return async (stamp) => {
                // The archive's `home/` IS the home folder, one for one.
                onProgress?.('home files', 0, 1);
                movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
                onProgress?.('home files', 1, 1);
                const containerDatabases: VersionedDatabase[] = [];
                for (const [index, summary] of manifest.mounts.entries()) {
                    containerDatabases.push(...materializeMount(homeDir, summary, stamp));
                    onProgress?.('mounts', index + 1, manifest.mounts.length);
                }

                // What landed is still a database this server can open. Before the identity write,
                // not after it (the spec has these the other way around): the rollback moves folders,
                // and nothing takes a users3.db row back. A restore of a deleted user that failed
                // this check after re-inserting would leave a user who can sign in with no home —
                // and whose retry would find that user and skip the insert for good.
                checkRestoredDatabases(
                    homeDir,
                    manifest.mounts.map((summary) => summary.id),
                    containerDatabases,
                );

                // The rows that live outside the home folder (users only).
                restoreAuthRows(ownerId, manifest, folder);
                await restoreShares(ownerId, folder);
                await restoreAvatar(ownerId, folder);
            };
        },
        // A half-written extraction is not a home: it keeps a name of its own, which the admin pane
        // lists with a delete and no restore.
        (stamp) => buildSafetyCopyName(homeDir, 'failed-restore', stamp),
    );
    onProgress?.('done', 1, 1);
}

// Puts a `.pre-restore-` copy back where it came from: the home as it stands becomes a safety copy
// of its own and the chosen folder takes its place. No bytes are written and none are deleted — a
// remote mount needs no work either, because the copy still points at the objects it was restored
// away from (materializeMount gives every restore fresh keys). A `.failed-restore-` copy is refused:
// it is the half-written folder of a restore that never finished, not a home.
export async function restoreSafetyCopy(
    ownerId: string,
    name: string,
    jobId: string,
    onProgress?: SnapshotProgress,
): Promise<void> {
    const { folder, homeDir, kind } = await resolveSafetyCopy(ownerId, name);
    if (kind !== 'pre-restore') throw new ApiError(400, `${name} is not a pre-restore copy of this home`);
    if (!fs.existsSync(folder)) throw new ApiError(404, `${name} is not beside this home`);
    await requireOwnerExists(ownerId);

    const install: InstallHome = async () => {
        onProgress?.('home files', 0, 1);
        fs.renameSync(folder, homeDir);
        // The copy is not at that path any more, and a later one can land on the same name (one
        // stamp per second) — it would then list the size measured for this folder.
        forgetSafetyCopySize(folder);
        onProgress?.('home files', 1, 1);
        // The verdict a restore from an archive ends on: SQLite's on the bytes, and this build's on
        // every schema stamp. A copy this server made passes both; one carried over from a newer
        // server does not, and that has to surface here rather than on the next load.
        const mountsDir = path.join(homeDir, PATHS.DRIVE.ROOT);
        const mountIds = fs.existsSync(mountsDir)
            ? fs
                  .readdirSync(mountsDir, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => entry.name)
            : [];
        checkRestoredDatabases(homeDir, mountIds, containerDatabasesIn(homeDir, mountIds));
    };

    await replaceHomeFolder(
        ownerId,
        homeDir,
        jobId,
        // Nothing to unpack or judge: the folder is right there, and resolveSafetyCopy vouched for it.
        async () => install,
        // Back under the name it came from. A `.failed-restore-` name would make a pristine home
        // unrestorable, and the only action left on one deletes its bytes.
        () => folder,
    );
    onProgress?.('done', 1, 1);
}

// Boot: a restore killed anywhere between the move-aside and the last install step left the home
// folder either gone or half written, with its real contents under the `{id}.pre-restore-{ts}` its
// marker names. The process that knew about it is dead, so nothing else will ever put it back —
// this does, loudly. The install writes a completion note beside the marker, so a restore that
// finished is told from one that did not. It runs before the staging wipe, which is what clears the
// markers of both. A safety copy with no marker is not evidence of anything: nothing deletes them
// automatically, so a deleted user leaves one behind.
export function recoverInterruptedRestores(): void {
    const stagingRoot = path.join(backupsDirPath(), '.staging');
    if (!fs.existsSync(stagingRoot)) return;
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jobDir = path.join(stagingRoot, entry.name);
        const marker = readRestoringMarker(path.join(jobDir, RESTORING_MARKER));
        if (!marker) continue;
        // The install finished; whatever the job did after that is nobody's business now.
        if (fs.existsSync(path.join(jobDir, RESTORE_COMPLETE_MARKER))) continue;
        const aside = path.join(path.dirname(marker.homeDir), marker.preRestoreName);
        // No copy to put back: the restore's own rollback already did it, or there is nothing left
        // to reason about. Either way this must not move the home folder that is in place.
        if (!fs.existsSync(aside)) continue;
        // A folder that is there without the completion note is the half-written one: the extract
        // landed and the mount materialization, the checks or the identity writes did not. It keeps
        // a name of its own, exactly as a failure the job itself caught would have left it, and the
        // home as it was goes back. Nothing is deleted.
        if (fs.existsSync(marker.homeDir)) {
            const parked = buildSafetyCopyName(marker.homeDir, 'failed-restore', freeStamp(marker.homeDir, new Date()));
            fs.renameSync(marker.homeDir, parked);
            console.error(
                `[backup] a restore of ${marker.ownerId} was interrupted mid-install: the half-written folder is ${path.basename(parked)}`,
            );
        }
        fs.renameSync(aside, marker.homeDir);
        console.error(
            `[backup] a restore of ${marker.ownerId} was interrupted: ${marker.preRestoreName} is back in place as the home folder`,
        );
    }
}
