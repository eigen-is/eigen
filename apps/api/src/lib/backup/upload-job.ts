// The upload of a finished server archive to the backup bucket, run as a job of its own. A server backup starts one
// as it ends, and the owner's Upload sends an archive again. It holds no home slot, so a backup never waits for the
// bucket, and its outcome goes into the archive's record and never fails the archive.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupJob, ServerArchiveUpload } from '@workspace/lib/types/backup';
import { orgOwnerId } from '@workspace/lib/types/owner';
import { canUploadServerArchive, isCompleteArchive, parseServerArchiveName } from '@workspace/lib/validation';
import { getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { alertOwner } from '../user/alert-owner';
import { describeError } from './errors';
import { listBackupJobs, runningJobOn, startBackupJob } from './jobs';
import { backupsDirPath } from './paths';
import { readServerSidecar, writeServerSidecar } from './server-archives';
import { backupKey, uploadServerArchive } from './upload';

const UPLOAD_STOPPED = 'Eigen stopped before the upload finished';

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

// Uploads take turns: two at once share one uplink and gain nothing.
let uploadsSettled: Promise<unknown> = Promise.resolve();

// An upload is a job that holds no slot, so a backup never waits for the bucket, and its failure is never the
// archive's. Shutdown aborts it, and the next Upload sends it whole.
export function startUploadJob(archivePath: string, startedBy: string | undefined): BackupJob {
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
