import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupJob } from '@workspace/lib/types/backup';
import { parseBackupManifest } from '@workspace/lib/validation';
import { ApiError } from '../core';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import { extractArtifact, packFolder, writeSidecar } from './archive';
import { buildArtifactName, buildHomeFolderName, getBackupStagingDir, getBackupsDir, parseArtifactName } from './paths';
import { type SnapshotProgress, snapshotHome } from './snapshot-home';
import { buildBackupJobEvent } from './sse-events';
import { verifyFolder } from './verify';

// A finished job stays this long so an admin who was away still sees the outcome. The artifact and
// its sidecar are the durable record, so dropping the job loses nothing.
export const BACKUP_JOB_RETENTION_MS = 60 * 60 * 1000;
// Progress is a stream, the poke is not: a home with thousands of files would otherwise put one SSE
// frame per file on the admin's channel. State changes always emit.
const PROGRESS_POKE_MS = 500;
// Enough of a verify's failure list for a message; the sidecar carries all of them.
const FAILURES_IN_MESSAGE = 3;

const jobs = new Map<string, BackupJob>();

function dropExpiredJobs(): void {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && now - Date.parse(job.finishedAt) > BACKUP_JOB_RETENTION_MS) jobs.delete(id);
    }
}

function poke(job: BackupJob): void {
    sendToHome(job.startedBy, { type: 'broadcast', event: buildBackupJobEvent(job.id, job.ownerId) }).catch(() => {});
}

// Runs `run` in the background and hands the caller the job to report back. Every run resolves to
// the artifact it worked on, so a finished job names one whatever its kind. One job per home at a
// time — a second backup while one is running would read a folder the first is still walking, and a
// second restore would move aside a folder the first is writing.
export function startBackupJob(
    kind: BackupJob['kind'],
    ownerId: string,
    adminId: string,
    run: (jobId: string, onProgress: SnapshotProgress) => Promise<string>,
): BackupJob {
    dropExpiredJobs();
    for (const running of jobs.values()) {
        if (running.ownerId === ownerId && running.state === 'running') {
            throw new ApiError(409, `A ${running.kind} of this home is already running`);
        }
    }

    const job: BackupJob = {
        id: randomUUID(),
        kind,
        ownerId,
        startedBy: adminId,
        state: 'running',
        progress: { step: 'starting', done: 0, total: 0 },
        startedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    poke(job);

    let lastPoke = Date.now();
    const onProgress: SnapshotProgress = (step, done, total) => {
        job.progress = { step, done, total };
        if (Date.now() - lastPoke < PROGRESS_POKE_MS) return;
        lastPoke = Date.now();
        poke(job);
    };

    run(job.id, onProgress)
        .then((artifact) => {
            job.state = 'done';
            job.artifact = artifact;
        })
        .catch((error: unknown) => {
            job.state = 'failed';
            job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
            job.finishedAt = new Date().toISOString();
            poke(job);
        });

    return job;
}

export function listBackupJobs(ownerId?: string): BackupJob[] {
    dropExpiredJobs();
    const all = [...jobs.values()].filter((job) => !ownerId || job.ownerId === ownerId);
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getBackupJob(id: string): BackupJob | undefined {
    dropExpiredJobs();
    return jobs.get(id);
}

// Two backups of one home inside the same second would otherwise land on one name, and the second
// would overwrite the first.
function freeArtifactName(ownerId: string, at: Date): string {
    let candidate = at;
    while (fs.existsSync(path.join(getBackupsDir(), buildArtifactName(ownerId, candidate)))) {
        candidate = new Date(candidate.getTime() + 1000);
    }
    return buildArtifactName(ownerId, candidate);
}

// The backup job: snapshot into staging, judge the folder before it is packed, pack it, write the
// sidecar. A failed verify still keeps the archive — an admin needs to see a bad backup, and the
// sidecar is where its failures are recorded — but ends the job failed and tells the admin.
export async function runHomeBackup(
    home: Home,
    adminId: string,
    jobId: string,
    onProgress: SnapshotProgress,
): Promise<string> {
    const staging = getBackupStagingDir(jobId);
    try {
        const manifest = await snapshotHome(home, staging, onProgress);
        const folder = path.join(staging, buildHomeFolderName(manifest.ownerId));
        const verify = await verifyFolder(folder, onProgress);
        const name = freeArtifactName(manifest.ownerId, new Date(manifest.createdAt));
        const artifactPath = path.join(getBackupsDir(), name);
        onProgress('pack', 0, 1);
        await packFolder(folder, artifactPath);
        onProgress('pack', 1, 1);
        await writeSidecar(artifactPath, manifest, verify);
        if (verify.status !== 'verified') {
            const failures = verify.failures.slice(0, FAILURES_IN_MESSAGE).join('; ');
            await sendToHome(adminId, {
                type: 'notification',
                notification: {
                    type: 'admin-alert',
                    title: `Backup of ${manifest.name} did not verify`,
                    body: failures,
                    tag: `backup-verify-${manifest.ownerId}`,
                    coalesce: true,
                },
            });
            throw new ApiError(500, `${name} did not verify: ${failures}`);
        }
        return name;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

// The verify job: unpack the artifact into staging, judge it, and leave the answer in the sidecar,
// which is what the artifact list reads. Failures end the job failed; the record stays either way.
export async function runArtifactVerify(
    artifactName: string,
    jobId: string,
    onProgress: SnapshotProgress,
): Promise<string> {
    const parsed = parseArtifactName(artifactName);
    if (!parsed) throw new ApiError(400, `${artifactName} is not a backup artifact name`);
    const artifactPath = path.join(getBackupsDir(), artifactName);
    const staging = getBackupStagingDir(jobId);
    try {
        const unpackDir = path.join(staging, 'verify');
        onProgress('extract', 0, 1);
        await extractArtifact(artifactPath, unpackDir);
        onProgress('extract', 1, 1);

        const folder = path.join(unpackDir, buildHomeFolderName(parsed.ownerId));
        if (!fs.existsSync(folder)) throw new ApiError(400, `${artifactName} is a backup of another home`);
        const record = await verifyFolder(folder, onProgress);
        const manifestPath = path.join(folder, 'manifest.json');
        const manifest = fs.existsSync(manifestPath)
            ? parseBackupManifest(fs.readFileSync(manifestPath, 'utf8'))
            : null;
        if (!manifest) throw new ApiError(400, `${artifactName} carries no version 1 backup manifest`);
        await writeSidecar(artifactPath, manifest, record);
        if (record.status !== 'verified') {
            throw new ApiError(
                500,
                `${artifactName} did not verify: ${record.failures.slice(0, FAILURES_IN_MESSAGE).join('; ')}`,
            );
        }
        return artifactName;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
