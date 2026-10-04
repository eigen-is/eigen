import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
    BackupJob,
    BackupLevel,
    BackupReason,
    ServerArchiveManifest,
    ServerArchiveSidecar,
    ServerArchiveUpload,
} from '@workspace/lib/types/backup';
import { orgOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_FORMAT_VERSION,
    canUploadServerArchive,
    isCompleteArchive,
    parseServerArchiveName,
    SERVER_ARCHIVE_EXTENSION,
} from '@workspace/lib/validation';
import { getDataRoot, getServerDataPath, ORG_HOMES_DIR, SERVER_DATABASES, SERVER_FILES } from '../config/paths';
import { PIN_KEYS } from '../config/release';
import { getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { pullHomeBackupBytes, pullHomeSnapshot } from '../home/home-relay';
import { getTeamExists } from '../team/team';
import { getUserById } from '../user';
import { alertOwner } from '../user/alert-owner';
import { type ArchiveWriter, createArchiveWriter, packFolder } from './archive';
import { enumerateHomes, type ServerHome } from './enumerate-homes';
import { describeError } from './errors';
import { listBackupJobs, runningJobOn, startBackupJob, waitForHomeSlot, whenSlotFree } from './jobs';
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
    wipeBackupStagingDir,
} from './paths';
import { pruneLocalArchives, readServerSidecar, writeServerSidecar } from './server-archives';
import { type SnapshotProgress, treeBytes } from './snapshot-home';
import { appendInstallFiles, assertEnvFileMounted, snapshotServer } from './snapshot-server';
import { backupKey, uploadServerArchive } from './upload';
import { readServerArchive, requireVerified, verifyFolder } from './verify';

const HOME_DELETED = 'deleted during the backup';
const UPLOAD_STOPPED = 'Eigen stopped before the upload finished';

type ServerBackupOptions = {
    level: BackupLevel;
    reason: BackupReason;
    startedBy?: string;
    // Wait out a server backup that runs rather than take its 409: the pre-update one does.
    wait?: boolean;
    // The waiting caller's: once it is gone, nothing starts when the slot frees.
    signal?: AbortSignal;
};

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

// Refuses a job the backups folder has no room for: every member uncompressed, plus the one staged and packed beside
// it, at most twice the largest. A home that cannot be sized is its capture's to judge.
async function requireRoom(level: BackupLevel, homes: ServerHome[]): Promise<void> {
    const sizes = [await serverMemberBytes()];
    for (const home of homes) {
        const bytes = await pullHomeBackupBytes(home.ownerId, level).catch((error) => {
            console.warn(`[backup] ${home.ownerId} could not be sized for the room check: ${describeError(error)}`);
            return 0;
        });
        sizes.push(bytes);
    }
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

// One home into the archive. A home that fails is named and the archive goes on: one broken bucket must not leave
// every other home without a backup. A failed append is the archive's failure and ends the job.
async function appendHome(
    writer: ArchiveWriter,
    home: ServerHome,
    { at, level, staging, onProgress }: { at: Date; level: BackupLevel; staging: string; onProgress: SnapshotProgress },
): Promise<ServerArchiveManifest['homes'][number]> {
    const folder = path.join(staging, buildHomeFolderName(home.ownerId));
    const member = buildHomeMemberName(home.ownerId, at);
    const packed = path.join(staging, path.basename(member));
    let bytes: number;
    let warnings: string[] | undefined;
    try {
        // Held for the capture only: meanwhile a per-home backup or restore of this home gets the
        // 409, as the server job waited out theirs.
        const release = await waitForHomeSlot(home.ownerId, 'server backup');
        const manifest = await pullHomeSnapshot(home.ownerId, staging, { level, onProgress }).finally(release);
        requireVerified(await verifyFolder(folder, onProgress), member);
        await packFolder(folder, packed);
        bytes = manifest.counts.bytes;
        warnings = manifest.warnings;
    } catch (error) {
        // A delete mid-capture throws whatever the torn-down home throws: the row says whether it is gone.
        const id = parseOwnerId(home.ownerId).id;
        const gone = home.kind === 'team' ? !(await getTeamExists(id)) : !(await getUserById(home.ownerId));
        return gone ? { ...home, skipped: HOME_DELETED } : { ...home, failed: describeError(error) };
    } finally {
        await fsp.rm(folder, { recursive: true, force: true });
    }
    await appendPacked(writer, member, packed);
    return { ...home, member, bytes, ...(warnings && { warnings }) };
}

// Into a temp file renamed into place once the manifest closes it, so nothing is left behind on a throw.
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
        assertEnvFileMounted();
        await snapshotServer(staging, at, (_step, done, total) => onProgress('server', done, total));
        const serverFolder = path.join(staging, buildServerFolderName(at));
        requireVerified(await verifyFolder(serverFolder), SERVER_ARCHIVE_SERVER_MEMBER);
        // The homes and the accounts in the archive are one moment.
        const { homes, orphans } = enumerateHomes(path.join(serverFolder, archiveServerPath(SERVER_DATABASES.users)));
        const packedServer = path.join(staging, SERVER_ARCHIVE_SERVER_MEMBER);
        await packFolder(serverFolder, packedServer);
        await fsp.rm(serverFolder, { recursive: true, force: true });
        await appendPacked(writer, SERVER_ARCHIVE_SERVER_MEMBER, packedServer);

        const summaries: ServerArchiveManifest['homes'] = [];
        for (const [index, home] of homes.entries()) {
            const step = `home ${index + 1} of ${homes.length}`;
            onProgress(step, 0, 0);
            const homeProgress: SnapshotProgress = (_step, done, total) => onProgress(step, done, total);
            summaries.push(await appendHome(writer, home, { at, level, staging, onProgress: homeProgress }));
        }

        const install = await appendInstallFiles(writer);
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
        await wipeBackupStagingDir(job.id);
    }
}

// The job, from its record to its retention. `admit` is called once the room check passes, so the
// caller can answer a refusal with its 507. A home that failed keeps the archive and fails the job. One backed up
// with warnings is in the archive, so the job is done, and ./eigen update goes on: the owner hears of it apart.
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
        sidecar.verify = (await readServerArchive(archivePath)).verify;
        requireVerified(sidecar.verify, name);
        const failed = sidecar.manifest.homes.filter((home) => home.failed);
        if (failed.length > 0) {
            const named = failed.map((home) => `${home.name} (${home.failed})`).join('; ');
            throw new Error(`${failed.length} of ${sidecar.manifest.homes.length} homes failed: ${named}`);
        }
        sidecar.state = 'done';
        const warned = sidecar.manifest.homes.flatMap((home) =>
            home.warnings?.length ? [`${home.name} (${home.warnings.join('; ')})`] : [],
        );
        if (warned.length > 0) {
            job.warnings = warned;
            const body = `${warned.length} of ${sidecar.manifest.homes.length} homes have warnings: ${warned.join('; ')}`;
            alertOwner('Server backup has warnings', body, `server-backup-warnings-${name}`).catch(() => {});
        }
    } catch (error) {
        sidecar.state = 'failed';
        sidecar.error = describeError(error);
        alertOwner('Server backup failed', sidecar.error, `server-backup-${name}`).catch(() => {});
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

// An upload is a job that holds no slot, so a backup never waits for the bucket, and its failure is never the
// archive's. Shutdown aborts it, and the next Upload sends it whole.
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
        const retention = { keep, partial: !isCompleteArchive(record?.manifest) };
        await uploadServerArchive(archivePath, s3, retention, signal);
        upload = { state: 'done', at: new Date(), key };
    } catch (error) {
        const reason = signal.aborted ? UPLOAD_STOPPED : describeError(error);
        upload = { state: 'failed', at: new Date(), key, error: reason };
        alertOwner('Server backup not uploaded', `${name}: ${reason}`, `server-backup-upload-${name}`).catch(() => {});
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
    const uploadEnabled = getServerSettings().backups.upload.enabled;
    if (!uploadEnabled) throw new ApiError(400, 'No backup bucket is set');
    const archivePath = path.join(backupsDirPath(), name);
    if (!fs.existsSync(archivePath)) throw new ApiError(404, 'Archive not found');
    const record = await readServerSidecar(archivePath);
    if (!canUploadServerArchive({ name, reason: parsed.reason, record }, { uploadEnabled, jobs: listBackupJobs() })) {
        // One upload of an archive at a time, a queued one included: a second would send it again.
        const busy = runningJobOn(name);
        const why = busy
            ? busy.kind === 'upload'
                ? 'is already being uploaded'
                : 'is still being written'
            : `${record ? 'did not verify' : 'has no readable record'}, so it is not uploaded`;
        throw new ApiError(409, `${name} ${why}`);
    }
    return startUploadJob(archivePath, startedBy);
}

// Starts the whole-server backup and resolves once it is under way. One runs at a time in the org's slot: a second
// start gets the 409 unless it is to `wait`, and no room is a 507 whose record stays, failed.
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

// What ./eigen backup follows over the control socket: plain JSON with no dates, since the CLI reads it
// without Eden's reviver. `bytes` is null until the archive is renamed into place.
export type ControlBackupJob = Pick<
    BackupJob,
    'id' | 'state' | 'progress' | 'artifact' | 'error' | 'uploadJobId' | 'warnings'
> & {
    bytes: number | null;
};

export function toControlJob({
    id,
    state,
    progress,
    artifact,
    error,
    uploadJobId,
    warnings,
}: BackupJob): ControlBackupJob {
    const archivePath = artifact && path.join(backupsDirPath(), artifact);
    const bytes = archivePath ? (fs.statSync(archivePath, { throwIfNoEntry: false })?.size ?? null) : null;
    return { id, state, progress, artifact, error, uploadJobId, warnings, bytes };
}
