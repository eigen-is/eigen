import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatFileSize } from '@workspace/lib/format';
import type {
    BackupJob,
    BackupLevel,
    BackupReason,
    ServerArchive,
    ServerArchiveManifest,
    ServerArchiveSidecar,
} from '@workspace/lib/types/backup';
import { orgOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_FORMAT_VERSION,
    parseServerArchiveName,
    parseServerArchiveSidecar,
    SERVER_ARCHIVE_EXTENSION,
} from '@workspace/lib/validation';
import { getEnvFile } from '../config/env';
import {
    DKIM_DIR,
    getDataRoot,
    getServerDataPath,
    ORG_HOMES_DIR,
    SERVER_DATABASES,
    SERVER_FILES,
} from '../config/paths';
import { PIN_KEYS } from '../config/release';
import { getPublicConfig } from '../config/server-config';
import { ApiError } from '../core';
import { pullHomeBackupBytes, pullHomeSnapshot, sendToHome } from '../home/home-relay';
import { getTeamExists } from '../team/team';
import { getOrgOwner, getUserById } from '../user';
import { type ArchiveWriter, createArchiveWriter, packFolder } from './archive';
import { enumerateHomes, type ServerHome } from './enumerate-homes';
import { describeError } from './errors';
import { listBackupJobs, startBackupJob, waitForHomeSlot, whenSlotFree } from './jobs';
import {
    archiveServerPath,
    backupsDirPath,
    buildHomeFolderName,
    buildHomeMemberName,
    buildServerArchiveName,
    buildServerFolderName,
    freeServerArchiveAt,
    getBackupStagingDir,
    getBackupsDir,
    getBackupTempPath,
    SERVER_ARCHIVE_SERVER_MEMBER,
    SERVER_SIDECAR_SUFFIX,
    serverSidecarPath,
    wipeBackupStagingDir,
} from './paths';
import { pruneServerArchives } from './retention';
import { type SnapshotProgress, treeBytes } from './snapshot-home';
import { appendInstallFiles, snapshotServer } from './snapshot-server';
import { FAILURES_IN_MESSAGE, verifyArchiveTransport, verifyFolder } from './verify';

const HOME_DELETED = 'deleted during the backup';
const INTERRUPTED = 'interrupted by a restart';

export type ServerBackupOptions = {
    level: BackupLevel;
    reason: BackupReason;
    // How many good scheduled archives the backups folder keeps once this job has written its own.
    keep: number;
    startedBy?: string;
    // Wait out a server backup that runs rather than take its 409: the pre-update one does.
    wait?: boolean;
    // The waiting caller's: once it is gone, nothing starts when the slot frees.
    signal?: AbortSignal;
};

async function writeServerSidecar(archivePath: string, sidecar: ServerArchiveSidecar): Promise<void> {
    const tempPath = getBackupTempPath(SERVER_SIDECAR_SUFFIX);
    try {
        await Bun.write(tempPath, JSON.stringify(sidecar, null, 2));
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, serverSidecarPath(archivePath));
}

// Null when there is none; a file that is there but is not one is an error, as with readSidecar.
export async function readServerSidecar(archivePath: string): Promise<ServerArchiveSidecar | null> {
    const filePath = serverSidecarPath(archivePath);
    if (!fs.existsSync(filePath)) return null;
    const sidecar = parseServerArchiveSidecar(await Bun.file(filePath).text());
    if (!sidecar) throw new ApiError(400, `${path.basename(filePath)} is not a server backup record`);
    return sidecar;
}

// What the server member stages at most: the databases and files of server/ it takes by name, and
// the org folder. Runtime files and strays in server/ stay out of the archive, and out of this.
function serverMemberBytes(): number {
    const sources = [...Object.values(SERVER_DATABASES), ...Object.values(SERVER_FILES)].map((name) =>
        getServerDataPath(name),
    );
    return [...sources, path.join(getDataRoot(), ORG_HOMES_DIR)].reduce((sum, source) => {
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        return sum + (stat?.isDirectory() ? treeBytes(source) : (stat?.size ?? 0));
    }, 0);
}

// Refuses a job the backups folder has no room for, before it writes anything. The bound is
// uncompressed: every member as it will be appended, plus the one being staged and packed beside
// it, which is at most twice the largest.
async function requireRoom(level: BackupLevel, homes: ServerHome[]): Promise<void> {
    const sizes = [serverMemberBytes()];
    for (const home of homes) sizes.push(await pullHomeBackupBytes(home.ownerId, level));
    const needed = 2 * Math.max(...sizes) + sizes.reduce((sum, bytes) => sum + bytes, 0);
    const { bavail, bsize } = fs.statfsSync(getBackupsDir());
    if (needed > bavail * bsize) {
        throw new ApiError(
            507,
            `A ${level} backup needs up to ${formatFileSize(needed)}; the backups folder has ${formatFileSize(bavail * bsize)} free`,
        );
    }
}

async function appendPacked(writer: ArchiveWriter, member: string, packed: string): Promise<void> {
    try {
        await writer.appendFile(member, packed);
    } finally {
        fs.rmSync(packed, { force: true });
    }
}

// A 404 means the home is gone only when its row is: one from its storage is a failure like any other.
async function ownerDeleted({ ownerId, kind }: ServerHome): Promise<boolean> {
    return kind === 'team' ? !(await getTeamExists(parseOwnerId(ownerId).id)) : !(await getUserById(ownerId));
}

// Step 5 of the job for one home. A home that fails is named in the manifest and the archive goes
// on without it: one broken bucket must not leave every other home without a backup. A home deleted
// since the listing is skipped, which is no failure. A failed append is the archive's failure, not
// the home's, and ends the job.
async function appendHome(
    writer: ArchiveWriter,
    home: ServerHome,
    { at, level, staging, onProgress }: { at: Date; level: BackupLevel; staging: string; onProgress: SnapshotProgress },
): Promise<ServerArchiveManifest['homes'][number]> {
    const folder = path.join(staging, buildHomeFolderName(home.ownerId));
    const member = buildHomeMemberName(home.ownerId, at);
    const packed = path.join(staging, path.basename(member));
    let bytes: number;
    try {
        // Held for the capture only: meanwhile a per-home backup or restore of this home gets the
        // 409, as the server job waited out theirs.
        const release = await waitForHomeSlot(home.ownerId, 'server backup');
        const manifest = await pullHomeSnapshot(home.ownerId, staging, { level, onProgress }).finally(release);
        const verify = await verifyFolder(folder, onProgress);
        if (verify.status !== 'verified') {
            throw new Error(`did not verify: ${verify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ')}`);
        }
        await packFolder(folder, packed);
        bytes = manifest.counts.bytes;
    } catch (error) {
        if (error instanceof ApiError && error.status === 404 && (await ownerDeleted(home))) {
            return { ...home, skipped: HOME_DELETED };
        }
        return { ...home, failed: describeError(error) };
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
    await appendPacked(writer, member, packed);
    return { ...home, member, bytes };
}

// Steps 3 to 6: the server member, the homes it names, the install files and the manifest, into a
// temp file renamed into place once the manifest closes it. Nothing is left behind on a throw.
async function writeServerArchive(
    job: BackupJob,
    archivePath: string,
    { level, reason, at }: { level: BackupLevel; reason: BackupReason; at: Date },
    onProgress: SnapshotProgress,
): Promise<ServerArchiveManifest> {
    const staging = getBackupStagingDir(job.id);
    const tempPath = getBackupTempPath(SERVER_ARCHIVE_EXTENSION);
    const writer = await createArchiveWriter(tempPath);
    try {
        await snapshotServer(staging, at, (_step, done, total) => onProgress('server', done, total));
        const serverFolder = path.join(staging, buildServerFolderName(at));
        const serverVerify = await verifyFolder(serverFolder);
        if (serverVerify.status !== 'verified') {
            const failures = serverVerify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ');
            throw new Error(`The server member did not verify: ${failures}`);
        }
        // The homes and the accounts in the archive are one moment.
        const { homes, orphans } = enumerateHomes(path.join(serverFolder, archiveServerPath(SERVER_DATABASES.users)));
        const packedServer = path.join(staging, SERVER_ARCHIVE_SERVER_MEMBER);
        await packFolder(serverFolder, packedServer);
        fs.rmSync(serverFolder, { recursive: true, force: true });
        await appendPacked(writer, SERVER_ARCHIVE_SERVER_MEMBER, packedServer);

        const summaries: ServerArchiveManifest['homes'] = [];
        for (const [index, home] of homes.entries()) {
            const step = `home ${index + 1} of ${homes.length}`;
            onProgress(step, 0, 0);
            const homeProgress: SnapshotProgress = (_step, done, total) => onProgress(step, done, total);
            summaries.push(await appendHome(writer, home, { at, level, staging, onProgress: homeProgress }));
        }

        const install = await appendInstallFiles(writer, {
            envFile: getEnvFile(),
            dkimDir: path.join(getDataRoot(), DKIM_DIR),
        });
        const config = getPublicConfig();
        const manifest = await writer.finish({
            formatVersion: BACKUP_FORMAT_VERSION,
            level,
            reason,
            createdAt: at.toISOString(),
            appVersion: config.version,
            domain: config.domain,
            homes: summaries,
            orphans,
            ...install,
            images: Object.fromEntries(
                PIN_KEYS.flatMap((key) => {
                    const value = process.env[key];
                    return value ? [[key, value] as const] : [];
                }),
            ),
        });
        fs.renameSync(tempPath, archivePath);
        return manifest;
    } finally {
        await writer.abort();
        wipeBackupStagingDir(job.id);
    }
}

// Fire-and-forget like the poke: a relay that fails must not replace the failure the job records.
export function alertOwner(tag: string, error: string): void {
    getOrgOwner()
        .then((owner) =>
            owner
                ? sendToHome(owner.id, {
                      type: 'notification',
                      notification: {
                          type: 'admin-alert',
                          title: 'Server backup failed',
                          body: error,
                          tag: `server-backup-${tag}`,
                          coalesce: true,
                      },
                  })
                : undefined,
        )
        .catch(() => {});
}

// Every server archive and sidecar-only record in the folder, keyed by its archive name.
function listServerRecords(dir: string): string[] {
    const names = new Set<string>();
    for (const file of fs.readdirSync(dir)) {
        const name = file.endsWith(SERVER_SIDECAR_SUFFIX) ? file.slice(0, -SERVER_SIDECAR_SUFFIX.length) : file;
        if (parseServerArchiveName(name)) names.add(name);
    }
    return [...names];
}

// The owner's list, newest first, from names and sidecars alone. A missing folder is an empty one.
export async function listServerArchives(): Promise<ServerArchive[]> {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return [];
    const archives: ServerArchive[] = [];
    for (const name of listServerRecords(dir)) {
        const parsed = parseServerArchiveName(name);
        if (!parsed) continue;
        const archivePath = path.join(dir, name);
        archives.push({
            name,
            level: parsed.level,
            reason: parsed.reason,
            createdAt: parsed.at,
            bytes: fs.statSync(archivePath, { throwIfNoEntry: false })?.size ?? null,
            record: await readServerSidecar(archivePath).catch(() => null),
        });
    }
    return archives.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// The schedule's one question. A failed or refused attempt left its record, so it counts: a night
// that fails is one alert, not a retry every tick.
export function hasScheduledAttemptOn(day: Date): boolean {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return false;
    const date = day.toISOString().slice(0, 10);
    return listServerRecords(dir).some((name) => {
        const parsed = parseServerArchiveName(name);
        return parsed?.reason === 'scheduled' && parsed.at.toISOString().slice(0, 10) === date;
    });
}

// An archive and its record go together, and a refused attempt's record alone. One still being
// written is refused: its job would write the record back when it ends. The job map says so
// whatever the record reads.
export async function deleteServerArchive(name: string): Promise<void> {
    if (!parseServerArchiveName(name)) throw new ApiError(400, 'Not a server backup name');
    const archivePath = path.join(backupsDirPath(), name);
    const recordPath = serverSidecarPath(archivePath);
    if (!fs.existsSync(archivePath) && !fs.existsSync(recordPath)) throw new ApiError(404, 'Archive not found');
    const writing = listBackupJobs().some((job) => job.state === 'running' && job.artifact === name);
    const record = await readServerSidecar(archivePath).catch(() => null);
    if (writing || record?.state === 'running') throw new ApiError(409, `${name} is still being written`);
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(recordPath, { force: true });
}

// Retention over the folder, judged by each sidecar: a scheduled archive counts as good only when its
// job ended done. An archive and its sidecar go together. One whose sidecar is missing or unreadable
// is left alone: nothing is deleted on a record nobody can read.
async function pruneLocalArchives(keep: number): Promise<void> {
    const dir = getBackupsDir();
    const archives: { name: string; good: boolean }[] = [];
    const unread: string[] = [];
    for (const name of listServerRecords(dir)) {
        const sidecar = await readServerSidecar(path.join(dir, name)).catch(() => null);
        if (sidecar) archives.push({ name, good: sidecar.state === 'done' });
        else unread.push(name);
    }
    if (unread.length > 0) {
        console.warn(`[backup] retention skips archives without a readable record: ${unread.join(', ')}`);
    }
    for (const name of pruneServerArchives(archives, keep)) {
        fs.rmSync(path.join(dir, name), { force: true });
        fs.rmSync(serverSidecarPath(path.join(dir, name)), { force: true });
    }
}

// Boot: a job killed mid-run left its record running, and nothing will ever end it. It becomes a
// failed attempt, for retention and the list alike, and the owner hears of it once.
export async function recoverInterruptedServerBackups(): Promise<void> {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return;
    const interrupted: string[] = [];
    for (const name of listServerRecords(dir)) {
        const archivePath = path.join(dir, name);
        const sidecar = await readServerSidecar(archivePath).catch(() => null);
        if (sidecar?.state !== 'running') continue;
        await writeServerSidecar(archivePath, {
            ...sidecar,
            state: 'failed',
            error: INTERRUPTED,
            finishedAt: new Date(),
        });
        interrupted.push(name);
    }
    if (interrupted.length > 0) alertOwner('interrupted', `${interrupted.join(', ')}: ${INTERRUPTED}`);
}

// The job, from its record to its retention. `admit` is called once the room check passes, so the
// caller can answer a refusal with its 507. A home that failed keeps the archive and fails the job.
async function runServerBackup(
    job: BackupJob,
    archivePath: string,
    options: { level: BackupLevel; reason: BackupReason; at: Date; keep: number },
    admit: () => void,
    onProgress: SnapshotProgress,
): Promise<string> {
    const name = path.basename(archivePath);
    const sidecar: ServerArchiveSidecar = { state: 'running', startedAt: job.startedAt };
    await writeServerSidecar(archivePath, sidecar);
    try {
        await requireRoom(options.level, enumerateHomes(getServerDataPath(SERVER_DATABASES.users)).homes);
        admit();
        sidecar.manifest = await writeServerArchive(job, archivePath, options, onProgress);
        onProgress('verify', 0, 1);
        sidecar.verify = await verifyArchiveTransport(archivePath);
        if (sidecar.verify.status !== 'verified') {
            throw new Error(
                `${name} did not verify: ${sidecar.verify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ')}`,
            );
        }
        const failed = sidecar.manifest.homes.filter((home) => home.failed);
        if (failed.length > 0) {
            const named = failed.map((home) => `${home.name} (${home.failed})`).join('; ');
            throw new Error(`${failed.length} of ${sidecar.manifest.homes.length} homes failed: ${named}`);
        }
        sidecar.state = 'done';
        return name;
    } catch (error) {
        sidecar.state = 'failed';
        sidecar.error = describeError(error);
        alertOwner(name, sidecar.error);
        throw error;
    } finally {
        sidecar.finishedAt = new Date();
        await writeServerSidecar(archivePath, sidecar);
        // Retention that throws must not replace the job's own outcome.
        await pruneLocalArchives(options.keep).catch(console.error);
    }
}

// Starts the whole-server backup and resolves once it is under way. One runs at a time, in the org's
// job slot: a second start is startBackupJob's 409, which names the archive being written, unless it
// is to `wait` for that one to end. No room is a 507, and the attempt's record stays, failed, like
// any other.
export async function startServerBackup({
    level,
    reason,
    keep,
    startedBy,
    wait,
    signal,
}: ServerBackupOptions): Promise<BackupJob> {
    const ownerId = orgOwnerId(getPublicConfig().orgId);
    const admitted = Promise.withResolvers<void>();
    const start = () => {
        const at = freeServerArchiveAt(reason, level, new Date());
        const archivePath = path.join(getBackupsDir(), buildServerArchiveName(reason, level, at));
        return startBackupJob('server-backup', ownerId, startedBy, (started, onProgress) => {
            started.reason = reason;
            started.artifact = path.basename(archivePath);
            const run = runServerBackup(
                started,
                archivePath,
                { level, reason, at, keep },
                admitted.resolve,
                onProgress,
            );
            // A promise settles once, so after admission this reject is a no-op.
            run.catch(admitted.reject);
            return run;
        });
    };
    const job = wait
        ? await whenSlotFree(ownerId, () => {
              signal?.throwIfAborted();
              return start();
          })
        : start();
    await admitted.promise;
    return job;
}
