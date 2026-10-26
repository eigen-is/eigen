// The API's entry point. It runs the recoveries a restart needs, starts the HTTP server, the control
// socket and the scheduled jobs, and on SIGTERM or SIGINT shuts them down in order, the homes last.

import { MAX_REQUEST_BODY_BYTES } from '@workspace/lib/constants/mount';
import { app } from './app';
import { drainBackupJobs } from './lib/backup/jobs';
import { wipeBackupStaging } from './lib/backup/paths';
import { recoverInterruptedRestores } from './lib/backup/recovery';
import { recoverInterruptedServerBackups } from './lib/backup/server-archives';
import { isProduction } from './lib/config/env';
import { assertMailDomainUnchanged, isSetupRequired } from './lib/config/server-config';
import { documentTransformRunner } from './lib/document/transform/runner';
import { drainACLFanOuts } from './lib/drive/acl-propagation';
import { shutdownAllHomes } from './lib/home';
import { drainHomeDeliveries } from './lib/home/home-relay';
import { pinDefaultTeam } from './lib/org';
import { registerScheduledJobs } from './lib/scheduler/jobs';
import { stopAllSchedules } from './lib/scheduler/scheduler';
import { createSetupLink } from './lib/setup/setup-token';
import { setShutdownDrainDeadline } from './lib/sync';
import { startControlSocket } from './routes/control';

// How long a shutdown may spend uploading the pending S3 writes. With the wait for the backup jobs
// before it, it stays below docker-compose's stop_grace_period, so the drain ends before SIGKILL. An
// upload that doesn't make it stays queued and runs again at the next boot.
const SHUTDOWN_DRAIN_BUDGET_MS = 20_000;

// Both before the server listens: a request that resolved a home while the recovery was still
// deciding about it would open a half-written folder as if it were the home. A restore that died
// between moving the home aside and installing the archive left a note in its staging folder, so
// that is read first, before the wipe takes the staging folders with it. Then they are cleared: a
// backup, verify or restore interrupted by a restart leaves a half-written folder nothing resumes.
recoverInterruptedRestores();
wipeBackupStaging();
// A server backup killed mid-run left its record running; it becomes a failed attempt.
await recoverInterruptedServerBackups().catch((error) => console.error('[backup] recovering server records:', error));

await assertMailDomainUnchanged();
await pinDefaultTeam().catch((error) => console.error('[org] pinning the default team:', error));

const server = app.listen({
    // 8000 in every deployment, because Caddy, Dovecot and the container healthcheck all name it. The
    // override lets a test start this file as a real child process on a free port, with the boot and
    // the signal handlers included.
    port: Number(process.env['EIGEN_API_PORT']) || 8000,
    // The streaming parser and the backup upload check their own limits per file. This is the backstop
    // under both.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Bun closes a connection that stays silent for a while, and that would cut off every slow response
    // that sends nothing until it is done. 200 s covers the slow protocol routes. The transform routes
    // can wait longer than Bun's cap of 255 s on this setting, so they and the copy routes switch it off
    // for their own request with server.timeout(request, 0). WebSockets keep their own keepalive.
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
    // The transforms stop taking jobs, and the one that runs finishes or is killed, before the mounts
    // and databases close below. A job holds no database, but its result must not land during the
    // teardown.
    await documentTransformRunner.close();
    // A running snapshot reads databases that shutdownAllHomes is about to close, and a half-done restore
    // would leave a user with no home folder. So the backup jobs settle first, before the S3 drain time
    // below starts counting.
    await drainBackupJobs();
    // Each mount uploads its queue during its close, until this deadline. That runs after the last writes
    // of the close are queued and before metadata.db closes.
    setShutdownDrainDeadline(Date.now() + SHUTDOWN_DRAIN_BUDGET_MS);
    // A delivery reopens its recipient's home, so the queued ACL fan-outs and every other delivery
    // still in flight, such as watcher and chat notifications, finish before the homes close.
    await drainACLFanOuts();
    await drainHomeDeliveries();
    await shutdownAllHomes();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
