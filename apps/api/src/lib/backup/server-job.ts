import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    BackupJob,
    BackupLevel,
    BackupReason,
    ServerArchive,
    ServerArchiveManifest,
    ServerArchiveSidecar,
    ServerArchiveUpload,
} from '@workspace/lib/types/backup';
import { orgOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_FORMAT_VERSION,
    parseServerArchiveName,
    parseServerArchiveNames,
    parseServerArchiveSidecar,
    SERVER_ARCHIVE_EXTENSION,
} from '@workspace/lib/validation';
import { getEnvFile } from '../config/env';
import {
    CERTS_DIR,
    DKIM_DIR,
    getDataRoot,
    getServerDataPath,
    ORG_HOMES_DIR,
    SERVER_DATABASES,
    SERVER_FILES,
} from '../config/paths';
import { API_IMAGE_KEY, PIN_KEYS } from '../config/release';
import { getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { pullHomeBackupBytes, pullHomeSnapshot, sendToHome } from '../home/home-relay';
import { getTeamExists } from '../team/team';
import { getOrgOwner, getUserById } from '../user';
import { type ArchiveWriter, createArchiveWriter, packFolder, writeRecord } from './archive';
import { enumerateHomes, type ServerHome } from './enumerate-homes';
import { describeError } from './errors';
import { runningJobOn, startBackupJob, waitForHomeSlot, whenSlotFree } from './jobs';
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
    roomShortfall,
    SERVER_ARCHIVE_SERVER_MEMBER,
    SERVER_SIDECAR_SUFFIX,
    serverSidecarPath,
    wipeBackupStagingDir,
} from './paths';
import { pruneServerArchives } from './retention';
import { type SnapshotProgress, treeBytes } from './snapshot-home';
import { appendInstallFiles, snapshotServer } from './snapshot-server';
import { backupKey, uploadServerArchive } from './upload';
import { describeFailures, verifyArchiveTransport, verifyFolder } from './verify';

const HOME_DELETED = 'deleted during the backup';
const INTERRUPTED = 'interrupted by a restart';
const UPLOAD_STOPPED = 'Eigen stopped before the upload finished';

export type ServerBackupOptions = {
    level: BackupLevel;
    reason: BackupReason;
    startedBy?: string;
    // Wait out a server backup that runs rather than take its 409: the pre-update one does.
    wait?: boolean;
    // The waiting caller's: once it is gone, nothing starts when the slot frees.
    signal?: AbortSignal;
};

function writeServerSidecar(archivePath: string, sidecar: ServerArchiveSidecar): Promise<void> {
    return writeRecord(serverSidecarPath(archivePath), sidecar);
}

// Null when there is none, or none that reads: nothing is judged or deleted on a record nobody can read.
export async function readServerSidecar(archivePath: string): Promise<ServerArchiveSidecar | null> {
    const text = await Bun.file(serverSidecarPath(archivePath))
        .text()
        .catch(() => null);
    return text === null ? null : parseServerArchiveSidecar(text);
}

// What the server member stages at most: the databases and files of server/ it takes by name, and
// the org folder. Runtime files and strays in server/ stay out of the archive, and out of this.
async function serverMemberBytes(): Promise<number> {
    const sources = [...Object.values(SERVER_DATABASES), ...Object.values(SERVER_FILES)].map((name) =>
        getServerDataPath(name),
    );
    let bytes = 0;
    for (const source of [...sources, path.join(getDataRoot(), ORG_HOMES_DIR)]) {
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        bytes += stat?.isDirectory() ? await treeBytes(source) : (stat?.size ?? 0);
    }
    return bytes;
}

// Refuses a job the backups folder has no room for, before it writes anything. The bound is
// uncompressed: every member as it will be appended, plus the one being staged and packed beside
// it, which is at most twice the largest. A home that cannot be sized is its capture's to judge.
async function requireRoom(level: BackupLevel, homes: ServerHome[]): Promise<void> {
    const sizes = [await serverMemberBytes()];
    for (const home of homes) sizes.push(await pullHomeBackupBytes(home.ownerId, level).catch(() => 0));
    const needed = 2 * Math.max(...sizes) + sizes.reduce((sum, bytes) => sum + bytes, 0);
    const shortfall = roomShortfall(`A ${level} backup`, needed, getBackupsDir(), 'the backups folder');
    if (shortfall) throw new ApiError(507, shortfall);
}

async function appendPacked(writer: ArchiveWriter, member: string, packed: string): Promise<void> {
    try {
        await writer.appendFile(member, packed);
    } finally {
        fs.rmSync(packed, { force: true });
    }
}

// One home into the archive. A home that fails is named in the manifest and the archive goes
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
            throw new Error(`did not verify: ${describeFailures(verify)}`);
        }
        await packFolder(folder, packed);
        bytes = manifest.counts.bytes;
    } catch (error) {
        // A delete mid-capture throws whatever the torn-down home throws: the row says whether it is gone.
        const id = parseOwnerId(home.ownerId).id;
        const gone = home.kind === 'team' ? !(await getTeamExists(id)) : !(await getUserById(home.ownerId));
        return gone ? { ...home, skipped: HOME_DELETED } : { ...home, failed: describeError(error) };
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
    await appendPacked(writer, member, packed);
    return { ...home, member, bytes };
}

// The server member, the homes it names, the install files and the manifest, into a
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
            throw new Error(`The server member did not verify: ${describeFailures(serverVerify)}`);
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
            certsDir: path.join(getDataRoot(), CERTS_DIR),
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
export function alertOwner(tag: string, error: string, title = 'Server backup failed'): void {
    getOrgOwner()
        .then((owner) =>
            owner
                ? sendToHome(owner.id, {
                      type: 'notification',
                      notification: {
                          type: 'admin-alert',
                          title,
                          body: error,
                          tag: `server-backup-${tag}`,
                          coalesce: true,
                      },
                  })
                : undefined,
        )
        .catch(() => {});
}

// Every server archive and sidecar-only record in the backups folder, once each, by its archive name, newest first.
// A missing folder holds none.
function listServerRecords() {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return [];
    const names = new Set(
        fs
            .readdirSync(dir)
            .map((file) =>
                file.endsWith(SERVER_SIDECAR_SUFFIX) ? file.slice(0, -SERVER_SIDECAR_SUFFIX.length) : file,
            ),
    );
    return parseServerArchiveNames(names).map((record) => ({ ...record, archivePath: path.join(dir, record.name) }));
}

// The owner's list, newest first, from names and sidecars alone.
export async function listServerArchives(): Promise<ServerArchive[]> {
    const archives: ServerArchive[] = [];
    for (const { name, level, reason, at, archivePath } of listServerRecords()) {
        archives.push({
            name,
            level,
            reason,
            createdAt: at,
            bytes: fs.statSync(archivePath, { throwIfNoEntry: false })?.size ?? null,
            record: await readServerSidecar(archivePath),
        });
    }
    return archives;
}

// What ./eigen backup follows over the control socket: plain JSON with no dates, since the CLI reads it
// without Eden's reviver. `bytes` is null until the archive is renamed into place.
export type ControlBackupJob = Pick<BackupJob, 'id' | 'state' | 'progress' | 'artifact' | 'error' | 'uploadJobId'> & {
    bytes: number | null;
};

export function toControlJob({ id, state, progress, artifact, error, uploadJobId }: BackupJob): ControlBackupJob {
    const archivePath = artifact && path.join(backupsDirPath(), artifact);
    const bytes = archivePath ? (fs.statSync(archivePath, { throwIfNoEntry: false })?.size ?? null) : null;
    return { id, state, progress, artifact, error, uploadJobId, bytes };
}

// The schedule's one question. A failed or refused attempt left its record, so it counts: a night
// that fails is one alert, not a retry every tick.
export function hasScheduledAttemptOn(day: Date): boolean {
    const date = day.toISOString().slice(0, 10);
    return listServerRecords().some(
        ({ reason, at }) => reason === 'scheduled' && at.toISOString().slice(0, 10) === date,
    );
}

// An archive and its record go together, and a refused attempt's record alone. One still being
// written is refused: its job would write the record back when it ends. The job map says so
// whatever the record reads: a record left running with no job behind it lost its final write.
export async function deleteServerArchive(name: string): Promise<void> {
    if (!parseServerArchiveName(name)) throw new ApiError(400, 'Not a server backup name');
    const archivePath = path.join(backupsDirPath(), name);
    const recordPath = serverSidecarPath(archivePath);
    if (!fs.existsSync(archivePath) && !fs.existsSync(recordPath)) throw new ApiError(404, 'Archive not found');
    if (runningJobOn(name)) throw new ApiError(409, `${name} is still being written`);
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(recordPath, { force: true });
}

// Retention over the folder, judged by each sidecar: an archive counts as good only when its job ended
// done. An archive and its sidecar go together. One whose sidecar is missing or unreadable is left
// alone: nothing is deleted on a record nobody can read.
async function pruneLocalArchives(): Promise<void> {
    const archives: Parameters<typeof pruneServerArchives>[0] = [];
    const unread: string[] = [];
    for (const record of listServerRecords()) {
        const sidecar = await readServerSidecar(record.archivePath);
        if (sidecar) {
            archives.push({
                ...record,
                good: sidecar.state === 'done',
                build: sidecar.manifest?.images[API_IMAGE_KEY],
            });
        } else unread.push(record.name);
    }
    if (unread.length > 0) {
        console.warn(`[backup] retention skips archives without a readable record: ${unread.join(', ')}`);
    }
    // An archive a job still reads, as an upload does, stays until the next round.
    const { keep } = getServerSettings().backups.schedule;
    for (const name of pruneServerArchives(archives, keep, process.env[API_IMAGE_KEY])) {
        if (runningJobOn(name)) continue;
        const archivePath = path.join(backupsDirPath(), name);
        fs.rmSync(archivePath, { force: true });
        fs.rmSync(serverSidecarPath(archivePath), { force: true });
    }
}

// Boot: a job killed mid-run left its record running, and nothing will ever end it. It becomes a
// failed attempt, for retention and the list alike, and an upload killed mid-run a failed upload, for the
// list and ./eigen status. The owner hears of each once.
export async function recoverInterruptedServerBackups(): Promise<void> {
    const interrupted: string[] = [];
    const notUploaded: string[] = [];
    for (const { name, archivePath } of listServerRecords()) {
        const sidecar = await readServerSidecar(archivePath);
        if (sidecar?.state === 'running') {
            await writeServerSidecar(archivePath, {
                ...sidecar,
                state: 'failed',
                error: INTERRUPTED,
                finishedAt: new Date(),
            });
            interrupted.push(name);
        } else if (sidecar?.upload?.state === 'running') {
            const upload: ServerArchiveUpload = {
                ...sidecar.upload,
                state: 'failed',
                at: new Date(),
                error: INTERRUPTED,
            };
            await writeServerSidecar(archivePath, { ...sidecar, upload });
            notUploaded.push(name);
        }
    }
    if (interrupted.length > 0) alertOwner('interrupted', `${interrupted.join(', ')}: ${INTERRUPTED}`);
    if (notUploaded.length > 0) {
        alertOwner('upload-interrupted', `${notUploaded.join(', ')}: ${INTERRUPTED}`, 'Server backup not uploaded');
    }
}

// The job, from its record to its retention. `admit` is called once the room check passes, so the
// caller can answer a refusal with its 507. A home that failed keeps the archive and fails the job.
async function runServerBackup(
    job: BackupJob,
    archivePath: string,
    options: { level: BackupLevel; reason: BackupReason; at: Date },
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
            throw new Error(`${name} did not verify: ${describeFailures(sidecar.verify)}`);
        }
        const failed = sidecar.manifest.homes.filter((home) => home.failed);
        if (failed.length > 0) {
            const named = failed.map((home) => `${home.name} (${home.failed})`).join('; ');
            throw new Error(`${failed.length} of ${sidecar.manifest.homes.length} homes failed: ${named}`);
        }
        sidecar.state = 'done';
    } catch (error) {
        sidecar.state = 'failed';
        sidecar.error = describeError(error);
        alertOwner(name, sidecar.error);
        throw error;
    } finally {
        sidecar.finishedAt = new Date();
        await writeServerSidecar(archivePath, sidecar);
        // Retention that throws must not replace the job's own outcome.
        await pruneLocalArchives().catch(console.error);
        // An archive that verified goes even when a home failed: the owner heard of the home, and the rest of the
        // server is worth its copy off the box. A pre-update archive exists for ./eigen rollback on this box.
        const uploads = getServerSettings().backups.upload.enabled && options.reason !== 'pre-update';
        if (uploads && sidecar.verify?.status === 'verified') {
            job.uploadJobId = startUploadJob(archivePath, job.startedBy).id;
        }
    }
    return name;
}

// Uploads take turns: two at once share one uplink and gain nothing.
let uploadsSettled: Promise<unknown> = Promise.resolve();

// An archive's upload is a job of its own that holds no slot, so a backup never waits for the bucket. A failure
// is never the archive's, which stays good here: the owner hears of it, and the record says so for the list and
// ./eigen status. Shutdown aborts it, and the next Upload sends it whole.
function startUploadJob(archivePath: string, startedBy: string | undefined): BackupJob {
    const name = path.basename(archivePath);
    const ownerId = orgOwnerId(getPublicConfig().orgId);
    return startBackupJob('upload', ownerId, startedBy, (job, onProgress, signal) => {
        job.artifact = name;
        const turn = uploadsSettled.then(async () => {
            onProgress('upload', 0, 1);
            const upload = await uploadAndRecord(archivePath, signal);
            if (upload.error) throw new Error(upload.error);
            return name;
        });
        uploadsSettled = turn.catch(() => {});
        return turn;
    });
}

async function recordUpload(archivePath: string, upload: ServerArchiveUpload): Promise<void> {
    const sidecar = await readServerSidecar(archivePath);
    if (sidecar) await writeServerSidecar(archivePath, { ...sidecar, upload });
}

// A restart before the upload ends leaves its record running, which the next boot marks failed.
async function uploadAndRecord(archivePath: string, signal: AbortSignal): Promise<ServerArchiveUpload> {
    const { s3, keep } = getServerSettings().backups.upload;
    const name = path.basename(archivePath);
    const key = backupKey(s3, name);
    await recordUpload(archivePath, { state: 'running', at: new Date(), key });
    let upload: ServerArchiveUpload;
    try {
        signal.throwIfAborted();
        const record = await readServerSidecar(archivePath);
        const retention = { keep, partial: record?.manifest?.homes.some((home) => home.failed) };
        upload = { state: 'done', at: new Date(), key: await uploadServerArchive(archivePath, s3, retention, signal) };
    } catch (error) {
        const reason = signal.aborted ? UPLOAD_STOPPED : describeError(error);
        upload = { state: 'failed', at: new Date(), key, error: reason };
        alertOwner(`upload-${name}`, `${name}: ${reason}`, 'Server backup not uploaded');
    }
    await recordUpload(archivePath, upload);
    return upload;
}

// The owner's Upload, for an archive whose upload failed or that predates the destination. Only one that
// verified goes, and never a pre-update one.
export async function startArchiveUpload(name: string, startedBy: string): Promise<BackupJob> {
    const parsed = parseServerArchiveName(name);
    if (!parsed) throw new ApiError(400, 'Not a server backup name');
    if (parsed.reason === 'pre-update') throw new ApiError(400, 'A pre-update backup stays on this server');
    if (!getServerSettings().backups.upload.enabled) throw new ApiError(400, 'No backup bucket is set');
    const archivePath = path.join(backupsDirPath(), name);
    if (!fs.existsSync(archivePath)) throw new ApiError(404, 'Archive not found');
    const sidecar = await readServerSidecar(archivePath);
    if (!sidecar) throw new ApiError(409, `${name} has no readable record, so it is not uploaded`);
    if (sidecar.verify?.status !== 'verified') throw new ApiError(409, `${name} did not verify, so it is not uploaded`);
    // One upload of an archive at a time, a queued one included: a second would send it again.
    const busy = runningJobOn(name);
    if (busy) {
        throw new ApiError(
            409,
            busy.kind === 'upload' ? `${name} is already being uploaded` : `${name} is still being written`,
        );
    }
    return startUploadJob(archivePath, startedBy);
}

// Starts the whole-server backup and resolves once it is under way. One runs at a time, in the org's
// job slot: a second start is startBackupJob's 409, which names the archive being written, unless it
// is to `wait` for that one to end. No room is a 507, and the attempt's record stays, failed, like
// any other.
export async function startServerBackup({
    level,
    reason,
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
            const run = runServerBackup(started, archivePath, { level, reason, at }, admitted.resolve, onProgress);
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
