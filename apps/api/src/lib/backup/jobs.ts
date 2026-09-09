import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupJob } from '@workspace/lib/types/backup';
import { parseBackupManifest } from '@workspace/lib/validation';
import { ApiError } from '../core';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import { extractArtifact, packFolder, writeSidecar } from './archive';
import { buildArtifactName, buildHomeFolderName, getBackupStagingDir, getBackupsDir } from './paths';
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
// How long shutdown waits for a backup or a verify. A restore is waited out however long it takes:
// killed between the move-aside and the install, it leaves the user with no home folder at all.
const SHUTDOWN_JOB_BUDGET_MS = 30_000;

const jobs = new Map<string, BackupJob>();
// The same jobs while they run, with the promise to wait on. Kept apart from the map above, which
// is serialized to the admin pane.
const inFlight = new Map<string, { kind: BackupJob['kind']; settled: Promise<void> }>();

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
    run: (job: BackupJob, onProgress: SnapshotProgress) => Promise<string>,
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

    const settled = run(job, onProgress)
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
            inFlight.delete(job.id);
            poke(job);
        });
    inFlight.set(job.id, { kind, settled });

    return job;
}

// Shutdown: a running snapshot reads databases the home teardown is about to close, and a restore
// killed halfway leaves a home folder that only the boot-time recovery can put back. Restores are
// waited out in full; a backup or verify gets a budget and is then left to die with the process
// (its staging folder goes in the next boot's wipe).
export async function drainBackupJobs(): Promise<void> {
    const running = [...inFlight.values()];
    if (running.length === 0) return;
    const restores = running.filter((entry) => entry.kind === 'restore').map((entry) => entry.settled);
    const rest = running.filter((entry) => entry.kind !== 'restore').map((entry) => entry.settled);
    console.log(`[backup] waiting for ${running.length} running job(s) before shutdown`);
    await Promise.all(restores);
    if (rest.length > 0) await Promise.race([Promise.all(rest), Bun.sleep(SHUTDOWN_JOB_BUDGET_MS)]);
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
export async function runHomeBackup(home: Home, job: BackupJob, onProgress: SnapshotProgress): Promise<string> {
    const staging = getBackupStagingDir(job.id);
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
            // Fire-and-forget like the poke: a relay that fails must not replace the failure the
            // admin actually needs to read in the job.
            sendToHome(job.startedBy, {
                type: 'notification',
                notification: {
                    type: 'admin-alert',
                    title: `Backup of ${manifest.name} did not verify`,
                    body: failures,
                    tag: `backup-verify-${manifest.ownerId}`,
                    coalesce: true,
                },
            }).catch(() => {});
            throw new Error(`${name} did not verify: ${failures}`);
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
    job: BackupJob,
    onProgress: SnapshotProgress,
): Promise<string> {
    const artifactPath = path.join(getBackupsDir(), artifactName);
    const staging = getBackupStagingDir(job.id);
    try {
        const unpackDir = path.join(staging, 'verify');
        onProgress('extract', 0, 1);
        await extractArtifact(artifactPath, unpackDir);
        onProgress('extract', 1, 1);

        // The job's owner is the one in the artifact's name, which the route parsed.
        const folder = path.join(unpackDir, buildHomeFolderName(job.ownerId));
        if (!fs.existsSync(folder)) throw new Error(`${artifactName} is a backup of another home`);
        const record = await verifyFolder(folder, onProgress);
        const manifestPath = path.join(folder, 'manifest.json');
        const manifest = fs.existsSync(manifestPath)
            ? parseBackupManifest(fs.readFileSync(manifestPath, 'utf8'))
            : null;
        if (!manifest) throw new Error(`${artifactName} carries no version 1 backup manifest`);
        await writeSidecar(artifactPath, manifest, record);
        if (record.status !== 'verified') {
            throw new Error(
                `${artifactName} did not verify: ${record.failures.slice(0, FAILURES_IN_MESSAGE).join('; ')}`,
            );
        }
        return artifactName;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
