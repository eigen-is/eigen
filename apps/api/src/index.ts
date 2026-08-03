import { app } from './app';
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

const server = app.listen({
    port: 8000,
    maxRequestBodySize: 1024 * 1024 * 1024, // 1 GB — per-file limits enforced by streaming parser
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
