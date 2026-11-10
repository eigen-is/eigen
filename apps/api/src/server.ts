// The API server, which the entry point loads once this process holds its data folder. It runs the recoveries a
// restart needs, starts the HTTP server, the control socket and the scheduled jobs. On SIGTERM or SIGINT it shuts
// them down in order, the homes last, and only then gives up the data folder's lock.

import { MAX_REQUEST_BODY_BYTES } from '@workspace/lib/constants/mount';
import { app } from './app';
import { releaseInstanceLock } from './instance-lock';
import { drainBackupJobs } from './lib/backup/jobs';
import { recoverBackupsAfterRestart } from './lib/backup/recovery';
import { isProduction } from './lib/config/env';
import { assertMailDomainUnchanged, isSetupRequired } from './lib/config/server-config';
import { documentTransformRunner } from './lib/document/transform/runner';
import { shutdownAllHomes } from './lib/home';
import { drainDeliveriesWithin } from './lib/home/home-relay';
import { setShutdownDrainDeadline } from './lib/mount/upload-limits';
import { registerScheduledJobs } from './lib/scheduler/jobs';
import { stopAllSchedules } from './lib/scheduler/scheduler';
import { createSetupLink } from './lib/setup/setup-token';
import { startControlSocket } from './routes/control';

// How long a shutdown may spend uploading pending S3 writes. With the waits before it, it stays below docker-compose's
// stop_grace_period, and an upload that doesn't make it runs again at the next boot.
const SHUTDOWN_DRAIN_BUDGET_MS = 20_000;

// How long a shutdown waits for the deliveries into other homes before it closes the homes. A delivery
// that hangs, such as on a stalled bucket, is given up after it, so the upload time above stays whole.
const SHUTDOWN_DELIVERY_BOUND_MS = 10_000;

await recoverBackupsAfterRestart();

assertMailDomainUnchanged();

const server = app.listen({
    // 8000 in every deployment, because Caddy, Dovecot and the container healthcheck all name it. The override runs a
    // second API beside it, such as a test's child process or a second dev stack.
    port: Number(process.env['EIGEN_API_PORT']) || 8000,
    // The streaming parser and the backup upload check their own limits per file. This is the backstop
    // under both.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Bun closes a silent connection, which would cut off a slow response that sends nothing until it is done. 200 s
    // covers the protocol routes; transforms and copies switch it off per request with server.timeout(request, 0).
    idleTimeout: 200,
});

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

const controlSocket = startControlSocket();

// `bun run dev` has no ./eigen setup to print the link.
if (!isProduction() && isSetupRequired()) console.log(`Finish the setup at ${createSetupLink().setupUrl}`);

registerScheduledJobs();

async function gracefulShutdown(signal: string) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    stopAllSchedules();
    server.stop();
    controlSocket.stop();
    // The transforms stop before the mounts and databases close below: a job holds no database, but its result must not
    // land during the teardown.
    await documentTransformRunner.close();
    // A running snapshot reads databases shutdownAllHomes is about to close, and a half-done restore would leave a user
    // with no home folder. So the backup jobs settle before the S3 drain time starts counting.
    await drainBackupJobs();
    // A delivery reopens its recipient's home, so every delivery still running finishes before the homes close.
    await drainDeliveriesWithin(SHUTDOWN_DELIVERY_BOUND_MS);
    // Each mount uploads its queue during its close, until this deadline. That runs after the last writes
    // of the close are queued and before metadata.db closes.
    setShutdownDrainDeadline(Date.now() + SHUTDOWN_DRAIN_BUDGET_MS);
    await shutdownAllHomes();
    releaseInstanceLock();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
