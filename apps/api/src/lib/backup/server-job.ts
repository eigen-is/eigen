import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatFileSize } from '@workspace/lib/format';
import type {
    BackupJob,
    BackupLevel,
    BackupReason,
    ServerArchiveManifest,
    ServerArchiveSidecar,
} from '@workspace/lib/types/backup';
import { orgOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_FORMAT_VERSION,
    parseServerArchiveName,
    parseServerArchiveSidecar,
    SERVER_ARCHIVE_EXTENSION,
} from '@workspace/lib/validation';
import { PIN_KEYS } from '../../cli/install';
import { getEnvFile } from '../config/env';
import {
    DKIM_DIR,
    getDataRoot,
    getServerDataPath,
    ORG_HOMES_DIR,
    SERVER_DATABASES,
    SERVER_FILES,
} from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { ApiError } from '../core';
import { pullHomeBackupBytes, pullHomeSnapshot, sendToHome } from '../home/home-relay';
import { getOrgOwner } from '../user';
import { type ArchiveWriter, createArchiveWriter, packFolder } from './archive';
import { enumerateHomes, type ServerHome } from './enumerate-homes';
import { describeError } from './errors';
import { listBackupJobs, startBackupJob, waitForHomeSlot } from './jobs';
import {
    archiveServerPath,
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

export type ServerBackupOptions = {
    level: BackupLevel;
    reason: BackupReason;
    // How many good scheduled archives the backups folder keeps once this job has written its own.
    keep: number;
    startedBy?: string;
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

// Refuses a job the backups folder has no room for, before it writes anything. The bound is
// uncompressed: every member as it will be appended, plus the one being staged and packed beside
// it, which is at most twice the largest.
async function requireRoom(level: BackupLevel, homes: ServerHome[]): Promise<void> {
    const listed = new Set<string>([...Object.values(SERVER_DATABASES), ...Object.values(SERVER_FILES)]);
    const orgDir = path.join(getDataRoot(), ORG_HOMES_DIR);
    const sizes = [
        treeBytes(getServerDataPath(), (rel) => !listed.has(rel.split('/')[0])) +
            (fs.existsSync(orgDir) ? treeBytes(orgDir) : 0),
    ];
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

// Step 5 of the job for one home. A home that fails is named in the manifest and the archive goes
// on without it: one broken bucket must not leave every other home without a backup. A failed
// append is the archive's failure, not the home's, and ends the job.
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
function alertOwner(archiveName: string, error: string): void {
    getOrgOwner()
        .then((owner) =>
            owner
                ? sendToHome(owner.id, {
                      type: 'notification',
                      notification: {
                          type: 'admin-alert',
                          title: 'Server backup failed',
                          body: error,
                          tag: `server-backup-${archiveName}`,
                          coalesce: true,
                      },
                  })
                : undefined,
        )
        .catch(() => {});
}

// Every server archive and sidecar-only record in the folder, judged by its sidecar: a scheduled
// one counts as good only when its job ended done. An archive and its sidecar go together.
async function pruneLocalArchives(keep: number): Promise<void> {
    const dir = getBackupsDir();
    const names = new Set<string>();
    for (const file of fs.readdirSync(dir)) {
        const name = file.endsWith(SERVER_SIDECAR_SUFFIX) ? file.slice(0, -SERVER_SIDECAR_SUFFIX.length) : file;
        if (parseServerArchiveName(name)) names.add(name);
    }
    const archives = await Promise.all(
        [...names].map(async (name) => {
            const sidecar = await readServerSidecar(path.join(dir, name)).catch(() => null);
            return { name, good: sidecar?.state === 'done' };
        }),
    );
    for (const name of pruneServerArchives(archives, keep)) {
        fs.rmSync(path.join(dir, name), { force: true });
        fs.rmSync(serverSidecarPath(path.join(dir, name)), { force: true });
    }
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
        await pruneLocalArchives(options.keep);
    }
}

// Starts the whole-server backup and resolves once it is under way. One runs at a time: a second
// start is a 409 naming the archive being written. No room is a 507, and the attempt's record
// stays, failed, like any other.
export async function startServerBackup({ level, reason, keep, startedBy }: ServerBackupOptions): Promise<BackupJob> {
    const ownerId = orgOwnerId(getPublicConfig().orgId);
    const running = listBackupJobs(ownerId).find((job) => job.state === 'running');
    if (running) throw new ApiError(409, `A server backup is already running: ${running.artifact}`);

    const at = freeServerArchiveAt(reason, level, new Date());
    const archivePath = path.join(getBackupsDir(), buildServerArchiveName(reason, level, at));
    const admitted = Promise.withResolvers<void>();
    const job = startBackupJob('server-backup', ownerId, startedBy, (started, onProgress) => {
        started.reason = reason;
        started.artifact = path.basename(archivePath);
        const run = runServerBackup(started, archivePath, { level, reason, at, keep }, admitted.resolve, onProgress);
        // A promise settles once, so after admission this reject is a no-op.
        run.catch(admitted.reject);
        return run;
    });
    await admitted.promise;
    return job;
}
