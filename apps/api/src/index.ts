import { app } from './app';
import { shutdownAllHomes } from './lib/home';
import { registerScheduledJobs } from './lib/scheduler/jobs';
import { stopAllSchedules } from './lib/scheduler/scheduler';

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
    await shutdownAllHomes();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
