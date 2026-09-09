import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { parseBackupManifest } from '@workspace/lib/validation';
import { eq, getTableColumns, inArray } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
    account,
    apikey,
    member,
    organization,
    team,
    teamMember,
    twoFactor,
    user as userTable,
} from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { closeCollabConnectionsForHome } from '../collab/connections';
import { getAvatarsDir, getTeamDataPath, getUserHomePath } from '../config/paths';
import { ApiError, PATHS } from '../core';
import { clearHomeRestoring, evictHome, markHomeRestoring } from '../home/get-home';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { getUserById } from '../user/user';
import { extractArtifact } from './archive';
import {
    ARCHIVE_HOME_DIR,
    buildHomeFolderName,
    buildStamp,
    FAILED_RESTORE_SUFFIX,
    getBackupStagingDir,
    getBackupsDir,
    PRE_RESTORE_SUFFIX,
    parseArtifactName,
} from './paths';
import { HOME_DATABASE_PATHS, type SnapshotProgress } from './snapshot-home';
import { archivePath, listManagedDatabases, type MountPathRow, storageKeyOf } from './snapshot-mount';
import { verifyFolder } from './verify';

// How many verify failures the refusal message repeats; the whole list is in the record.
const REPORTED_FAILURES = 3;

// The users3.db rows snapshot-home writes into auth.json, keyed by table name. Sessions are not
// among them: a restore puts a home's data back, it does not hand out logins.
type AuthArchive = {
    user?: (typeof userTable.$inferInsert)[];
    account?: (typeof account.$inferInsert)[];
    two_factor?: (typeof twoFactor.$inferInsert)[];
    apikey?: (typeof apikey.$inferInsert)[];
    member?: (typeof member.$inferInsert)[];
    team_member?: (typeof teamMember.$inferInsert)[];
};

// Where this owner's home folder lives. Org homes hold no databases and guest homes are disposable
// (guest-cleanup deletes them), so neither is backed up and neither can be restored.
async function resolveHomeDir(ownerId: string): Promise<string> {
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') return getTeamDataPath(owner.id);
    if (owner.type !== 'user') throw new ApiError(400, `Cannot restore a ${owner.type} home`);
    const existing = await getUserById(owner.id);
    if (existing?.role === 'guest') throw new ApiError(400, 'Guest homes are not backed up');
    return getUserHomePath(owner.id);
}

function isCrossDevice(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'EXDEV';
}

// The backups folder may sit on another disk than the data root, and a rename across the two fails
// with EXDEV — so fall back to a copy.
function movePath(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (!isCrossDevice(error)) throw error;
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

// A mount's tree as the archive left it, plus the archive paths of the databases the mount itself
// manages — the same rule the capture used, read back from the same table.
function readMountTree(db: Database): { rows: MountPathRow[]; managed: Set<string> } {
    const rows = db.query<MountPathRow, []>('SELECT id, file, name, type, parentId, trashedFrom FROM paths').all();
    return { rows, managed: new Set(listManagedDatabases(rows).map((entry) => entry.path)) };
}

// Put one mount's files where the restored mount will look for them. The archive holds every file
// under `data/` by path (what a `local` mount stores natively); `local-key` re-derives its flat keys
// from the restored tree, and `s3` stages every file with a pending upload so the existing
// UploadQueue drains it to the bucket with its normal retry and backoff — the user can work at once,
// and a flaky bucket makes the restore resumable by construction.
function materializeMount(homeDir: string, summary: BackupManifest['mounts'][number]): void {
    const mountDir = path.join(homeDir, PATHS.DRIVE.ROOT, summary.id);
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadataPath)) {
        throw new ApiError(400, `The archive promises mount ${summary.id} but carries no metadata.db for it`);
    }
    const db = new Database(metadataPath);
    try {
        const { rows, managed } = readMountTree(db);
        const byId = new Map(rows.map((row) => [row.id, row]));
        // Every pending row names a staged copy on the source server that the archive does not carry.
        db.run('DELETE FROM pending_uploads');
        if (summary.storageType === 'local') {
            // The tree already IS the storage layout. Folders carry no bytes, so an empty one has no
            // archive entry — recreate them from the table, or a later rename of one 404s.
            for (const row of rows) {
                if (row.type === 'file' || row.parentId === null) continue;
                fs.mkdirSync(path.join(dataDir, archivePath(row, byId)), { recursive: true });
            }
            return;
        }

        const stagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
        if (summary.storageType === 's3') fs.mkdirSync(stagingDir, { recursive: true });
        const enqueue = db.prepare(
            'INSERT INTO pending_uploads (storageKey, stagingPath, attempt, enqueuedAt, nextAttemptAt, isDatabase)' +
                ' VALUES (?, ?, 0, ?, ?, ?)',
        );
        const now = Date.now();
        for (const row of rows) {
            if (row.type !== 'file') continue;
            const archived = archivePath(row, byId);
            const source = path.join(dataDir, archived);
            // A row whose storage object was already missing when the backup ran has no bytes here;
            // the restored home mirrors that absence rather than inventing an empty object.
            if (!fs.existsSync(source)) continue;
            const key = storageKeyOf(row, byId, false);
            if (summary.storageType === 's3') {
                const staged = randomUUID();
                movePath(source, path.join(stagingDir, staged));
                enqueue.run(key, staged, now, now, managed.has(archived) ? 1 : 0);
            } else {
                movePath(source, path.join(dataDir, key));
            }
        }
        enqueue.finalize();
        // What is left under data/ is the archive's by-path folders: empty for local-key (whose keys
        // are flat), and the whole tree for s3 (whose bytes belong in the bucket, not here).
        if (summary.storageType === 's3') fs.rmSync(dataDir, { recursive: true, force: true });
        else pruneEmptyDirs(dataDir);
    } finally {
        db.close();
    }
}

// Two restores of one home within the same second would otherwise pick the same safety-copy name,
// and renaming onto an existing folder fails (ENOTEMPTY) — with the home already moved aside.
function freeName(candidate: string): string {
    let free = candidate;
    for (let n = 2; fs.existsSync(free); n++) free = `${candidate}-${n}`;
    return free;
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
    const authPath = path.join(folder, 'auth.json');
    if (!fs.existsSync(authPath)) return;
    const db = getAuthDrizzleDb();

    const existing = db.select().from(userTable).where(eq(userTable.id, ownerId)).get();
    if (existing) {
        if (manifest.email && existing.email !== manifest.email) {
            throw new ApiError(409, `${ownerId} is now ${existing.email}; the archive holds ${manifest.email}`);
        }
        return;
    }

    const archive: AuthArchive = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    for (const row of archive.user ?? []) {
        reviveDates(row, userTable);
        db.insert(userTable).values(row).run();
    }
    for (const row of archive.account ?? []) {
        reviveDates(row, account);
        db.insert(account).values(row).run();
    }
    for (const row of archive.two_factor ?? []) {
        reviveDates(row, twoFactor);
        db.insert(twoFactor).values(row).run();
    }
    for (const row of archive.apikey ?? []) {
        reviveDates(row, apikey);
        db.insert(apikey).values(row).run();
    }

    // A membership whose organization or team is gone would be an orphan, and better-auth's
    // listMembers chokes on those (see user/delete-user.ts). Say so and leave it out.
    const memberRows = archive.member ?? [];
    const liveOrgs = new Set(
        db
            .select({ id: organization.id })
            .from(organization)
            .where(
                inArray(
                    organization.id,
                    memberRows.map((row) => row.organizationId),
                ),
            )
            .all()
            .map((row) => row.id),
    );
    for (const row of memberRows) {
        if (!liveOrgs.has(row.organizationId)) {
            console.warn(`[backup] ${ownerId}: organization ${row.organizationId} is gone, membership not restored`);
            continue;
        }
        reviveDates(row, member);
        db.insert(member).values(row).run();
    }

    const teamRows = archive.team_member ?? [];
    const liveTeams = new Set(
        db
            .select({ id: team.id })
            .from(team)
            .where(
                inArray(
                    team.id,
                    teamRows.map((row) => row.teamId),
                ),
            )
            .all()
            .map((row) => row.id),
    );
    for (const row of teamRows) {
        if (!liveTeams.has(row.teamId)) {
            console.warn(`[backup] ${ownerId}: team ${row.teamId} is gone, membership not restored`);
            continue;
        }
        reviveDates(row, teamMember);
        db.insert(teamMember).values(row).run();
    }
}

// Insert missing only: a registry row that is already there describes a live share.
async function restoreShares(ownerId: string, folder: string): Promise<void> {
    const sharesPath = path.join(folder, 'shares.json');
    if (!fs.existsSync(sharesPath)) return;
    const rows: { targetIdentifier: string }[] = JSON.parse(fs.readFileSync(sharesPath, 'utf8'));
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
    const avatarDir = path.join(folder, 'avatar');
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
        const target = path.join(getAvatarsDir(), name);
        if (fs.existsSync(target)) continue;
        await Bun.write(target, Bun.file(path.join(avatarDir, name)));
    }
}

// SQLite's own verdict on what landed. The home is evicted and the restoring mark is still set, so
// this is the one place a live home's databases are opened directly — read-only, like verify.
function checkRestoredDatabases(homeDir: string, manifest: BackupManifest): void {
    const targets = [...HOME_DATABASE_PATHS].map((relPath) => path.join(homeDir, relPath));
    for (const summary of manifest.mounts) {
        const mountDir = path.join(homeDir, PATHS.DRIVE.ROOT, summary.id);
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        targets.push(metadataPath);
        // Only a `local` mount keeps its container databases as files at a knowable path. The other
        // two now hold theirs under a flat key or in staging, and verify read every one of them in
        // the folder this restore unpacked minutes ago.
        if (summary.storageType !== 'local' || !fs.existsSync(metadataPath)) continue;
        const db = new Database(metadataPath, { readonly: true });
        try {
            for (const relPath of readMountTree(db).managed) {
                targets.push(path.join(mountDir, PATHS.DRIVE.DATA_DIR, relPath));
            }
        } finally {
            db.close();
        }
    }

    for (const target of targets) {
        if (!fs.existsSync(target)) continue;
        const db = new Database(target, { readonly: true });
        try {
            const row = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
            if (row?.quick_check !== 'ok') {
                throw new ApiError(500, `${target} did not survive the restore: ${row?.quick_check ?? 'no answer'}`);
            }
        } finally {
            db.close();
        }
    }
}

// Replaces one home with the copy inside an artifact. Nothing is ever deleted: the home as it stands
// is renamed aside as `{id}.pre-restore-{ts}`, and a failure after that point leaves the incomplete
// folder as `{id}.failed-restore-{ts}` and puts the original back. The home is refused on every
// surface for the duration (markHomeRestoring) and its collab sockets are told to reload; the first
// load after the mark clears runs migrations, reconciles contacts and refreshes shared-with-me.
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

    markHomeRestoring(ownerId);
    let movedAside: string | null = null;
    try {
        // 1 — unpack into this job's staging folder and judge the archive before anything is touched.
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
            throw new ApiError(
                400,
                `${artifactName} did not verify: ${verified.failures.slice(0, REPORTED_FAILURES).join('; ')}`,
            );
        }

        // 2 — take the home away from everyone holding it. Sessions are untouched: the user stays
        // signed in, every request just meets the 503 until the mark clears.
        closeCollabConnectionsForHome(ownerId);
        await evictHome(ownerId);

        // 3 — move the current home aside. There is none on a restore after the user was deleted.
        const stamp = buildStamp(new Date());
        if (fs.existsSync(homeDir)) {
            movedAside = freeName(`${homeDir}${PRE_RESTORE_SUFFIX}${stamp}`);
            fs.renameSync(homeDir, movedAside);
        }

        try {
            // 4 — the archive's `home/` IS the home folder, one for one.
            onProgress?.('home files', 0, 1);
            movePath(path.join(folder, ARCHIVE_HOME_DIR), homeDir);
            onProgress?.('home files', 1, 1);
            for (const [index, summary] of manifest.mounts.entries()) {
                materializeMount(homeDir, summary);
                onProgress?.('mounts', index + 1, manifest.mounts.length);
            }

            // 5 — the rows that live outside the home folder (users only).
            restoreAuthRows(ownerId, manifest, folder);
            await restoreShares(ownerId, folder);
            await restoreAvatar(folder);

            // 6 — what landed is still what SQLite calls a database.
            checkRestoredDatabases(homeDir, manifest);
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

        clearHomeRestoring(ownerId);
        try {
            fs.rmSync(unpackDir, { recursive: true, force: true });
        } catch (error) {
            // The restore is done; a staging folder left behind is the boot-time wipe's problem.
            console.error(`[backup] could not clear the staging folder of job ${jobId}:`, error);
        }
        onProgress?.('done', 1, 1);
    } catch (error) {
        clearHomeRestoring(ownerId);
        throw error;
    }
}
