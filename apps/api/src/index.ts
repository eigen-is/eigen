import { BACKUP_UPLOAD_MAX_BYTES } from '@workspace/lib/constants/backup';
import { app } from './app';
import { drainBackupJobs } from './lib/backup/jobs';
import { wipeBackupStaging } from './lib/backup/paths';
import { recoverInterruptedRestores } from './lib/backup/recovery';
import { documentTransformRunner } from './lib/document/transform/runner';
import { drainACLFanOuts } from './lib/drive/acl-propagation';
import { shutdownAllHomes } from './lib/home';
import { registerScheduledJobs } from './lib/scheduler/jobs';
import { stopAllSchedules } from './lib/scheduler/scheduler';
import { setShutdownDrainDeadline } from './lib/sync';

// Wall-clock budget for flushing pending S3 uploads on shutdown. Must stay below
// docker-compose's stop_grace_period so the drain finishes before SIGKILL; anything
// not drained in time stays in pending_uploads and replays on the next boot.
const SHUTDOWN_DRAIN_BUDGET_MS = 20_000;

// A restore that died between moving the home aside and installing the archive left a note in its
// staging folder; read it before the wipe takes the staging folders with it. Then clear them: a
// backup, verify or restore interrupted by a restart leaves a half-written folder nothing resumes.
recoverInterruptedRestores();
wipeBackupStaging();

const server = app.listen({
    // 8000 in every deployment — Caddy, Dovecot and the container healthcheck all name it. The
    // override is what lets a test spawn this file as a real child process on a free port, boot
    // sequence and signal handlers included.
    port: Number(process.env['EIGEN_API_PORT']) || 8000,
    // The backup upload is the largest body the API accepts; per-file limits are enforced by the
    // streaming parser, and this is the backstop under the upload route's own check.
    maxRequestBodySize: BACKUP_UPLOAD_MAX_BYTES,
    // Bun closes idle connections by default (10s documented; ~30s observed on 1.3.14),
    // which killed every silent long-running response. 200s is a broad floor for slow
    // routes (large copies, protocol ops); it can NOT cover the transform routes — queue
    // wait + 120s deadline (+ 60s WeasyPrint) exceeds Bun's 255s cap on this knob — so
    // those exempt themselves per-request via server.timeout(request, 0) (routes/drive.ts).
    // WebSockets are unaffected (own keepalive config).
    idleTimeout: 200,
});

export type { App as app } from './app';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

registerScheduledJobs();

async function gracefulShutdown(signal: string) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    stopAllSchedules();
    server.stop();
    // Stop transform admission and finish/terminate the active Worker before the
    // Mount/database teardown below — jobs hold no db leases, but their results
    // must not race the cache/mount shutdown.
    await documentTransformRunner.close();
    // A running snapshot reads databases shutdownAllHomes is about to close, and a half-done restore
    // would leave a user with no home folder — so jobs settle before the teardown, and before the
    // S3 drain budget below starts counting.
    await drainBackupJobs();
    // Each mount flushes its upload queue (bounded by this deadline) during destruct, after
    // its final close-time enqueues but before metadata.db closes.
    setShutdownDrainDeadline(Date.now() + SHUTDOWN_DRAIN_BUDGET_MS);
    // In-flight ACL fan-outs reopen recipient homes to deliver, so drain them before closing homes.
    await drainACLFanOuts();
    await shutdownAllHomes();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
