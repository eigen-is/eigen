// The whole-server backup job: the server member, then every home at the archive's level, then the install files
// and the manifest, into one plain tar that is read back and checked. It starts from Settings, the nightly schedule
// or ./eigen backup over the control socket. It ends with retention, and hands a verified archive to an upload job.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
    BackupJob,
    BackupLevel,
    BackupProgress,
    BackupReason,
    ServerArchiveManifest,
    ServerArchiveSidecar,
} from '@workspace/lib/types/backup';
import { orgOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_FORMAT_VERSION, SERVER_ARCHIVE_EXTENSION } from '@workspace/lib/validation';
import { getDataRoot, getServerDataPath, ORG_HOMES_DIR, SERVER_DATABASES, SERVER_FILES } from '../config/paths';
import { PIN_KEYS } from '../config/release';
import { getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { isHomeDeleting } from '../home/get-home';
import { pullHomeBackupBytes, pullHomeSnapshot } from '../home/home-relay';
import { getTeamExists } from '../team/team';
import { getUserById } from '../user';
import { alertOwner } from '../user/alert-owner';
import type { ServerArchiveWriter } from './archive';
import { createServerArchiveWriter, packFolder } from './archive';
import type { ServerHome } from './enumerate-homes';
import { enumerateHomes } from './enumerate-homes';
import { describeError } from './errors';
import { treeBytes } from './file-tree';
import { startBackupJob, waitForHomeSlot, whenHomeSlotFree } from './jobs';
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
import { pruneLocalArchives, writeServerSidecar } from './server-archives';
import { appendInstallFiles, assertEnvFileMounted, snapshotServer } from './snapshot-server';
import { backupKey } from './upload';
import { startUploadJob } from './upload-job';
import { requireVerified, verifyFolder } from './verify';
import { readServerArchive } from './verify-server-archive';

const HOME_DELETED = 'deleted during the backup';

// What a server archive's name is made of, fixed when its job starts.
type ServerArchiveSpec = { level: BackupLevel; reason: BackupReason; at: Date };

type ServerBackupOptions = {
    level: BackupLevel;
    reason: BackupReason;
    startedBy?: string;
    // Wait out a server backup that runs rather than take its 409: the pre-update one does.
    wait?: boolean;
    // The waiting caller's: once it is gone, nothing starts when the slot frees.
    signal?: AbortSignal;
};

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
        ? await whenHomeSlotFree(ownerId, () => {
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

// The job, from its record to its retention. `admit` is called once the room check passes, so the caller can
// answer a refusal with its 507. A home that failed keeps the archive and fails the job. A home backed up with
// warnings is in the archive, so the job ends done and ./eigen update goes on. The owner gets an alert of its own.
async function runServerBackup(
    job: BackupJob,
    archivePath: string,
    options: ServerArchiveSpec,
    admit: () => void,
    onProgress: BackupProgress,
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
        // An archive that verified goes even when a home failed: the owner heard of the home, and the rest of the
        // server is worth its copy off the box. A pre-update archive exists for ./eigen rollback on this box.
        const { enabled, s3 } = getServerSettings().backups.upload;
        const uploads = enabled && options.reason !== 'pre-update' && sidecar.verify?.status === 'verified';
        // Running in the record the backup ends with, so ./eigen stop finds no moment where neither runs.
        if (uploads) sidecar.upload = { state: 'running', at: new Date(), key: backupKey(s3, name) };
        await writeServerSidecar(archivePath, sidecar);
        // Retention that throws must not replace the job's own outcome.
        await pruneLocalArchives().catch(console.error);
        if (uploads) job.uploadJobId = startUploadJob(archivePath, job.startedBy).id;
    }
    return name;
}

// Into a temp file renamed into place once the manifest closes it, so nothing is left behind on a throw.
async function writeServerArchive(
    job: BackupJob,
    archivePath: string,
    { level, reason, at }: ServerArchiveSpec,
    onProgress: BackupProgress,
): Promise<ServerArchiveManifest> {
    const staging = getBackupStagingDir(job.id);
    const tempPath = getBackupTempPath(SERVER_ARCHIVE_EXTENSION);
    const writer = await createServerArchiveWriter(tempPath);
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
            const homeProgress: BackupProgress = (_step, done, total) => onProgress(step, done, total);
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

// One home into the archive. A home that fails is named and the archive goes on: one broken bucket must not leave
// every other home without a backup. A failed append is the archive's failure and ends the job.
async function appendHome(
    writer: ServerArchiveWriter,
    home: ServerHome,
    { at, level, staging, onProgress }: { at: Date; level: BackupLevel; staging: string; onProgress: BackupProgress },
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
        const verify = await verifyFolder(folder, onProgress);
        requireVerified(verify, member);
        await packFolder(folder, packed);
        bytes = manifest.counts.bytes;
        // The pane lists the row's warnings, and a server archive keeps no per-home sidecar for the verify's.
        const all = [...(manifest.warnings ?? []), ...(verify.warnings ?? [])];
        warnings = all.length > 0 ? all : undefined;
    } catch (error) {
        // A delete mid-capture throws whatever the torn-down home throws: the mark or the row says whether it is gone.
        const id = parseOwnerId(home.ownerId).id;
        const gone =
            isHomeDeleting(home.ownerId) ||
            (home.kind === 'team' ? !(await getTeamExists(id)) : !(await getUserById(home.ownerId)));
        return gone ? { ...home, skipped: HOME_DELETED } : { ...home, failed: describeError(error) };
    } finally {
        await fsp.rm(folder, { recursive: true, force: true });
    }
    await appendPacked(writer, member, packed);
    return { ...home, member, bytes, ...(warnings && { warnings }) };
}

async function appendPacked(writer: ServerArchiveWriter, member: string, packed: string): Promise<void> {
    try {
        await writer.appendFile(member, packed);
    } finally {
        fs.rmSync(packed, { force: true });
    }
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
