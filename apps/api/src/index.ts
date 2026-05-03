import { app } from './app';
import { cleanupInactiveGuests } from './lib/auth/guest-cleanup';
import { shutdownAllHomes } from './lib/home';

const server = app.listen({
    port: 8000,
    maxRequestBodySize: 1024 * 1024 * 1024, // 1 GB — per-file limits enforced by streaming parser
});

export type { App as app } from './app';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

const GUEST_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
cleanupInactiveGuests().catch((error) => console.error('[guest-cleanup] sweep failed:', error));
const guestCleanupTimer = setInterval(() => {
    cleanupInactiveGuests().catch((error) => console.error('[guest-cleanup] sweep failed:', error));
}, GUEST_CLEANUP_INTERVAL_MS);

async function gracefulShutdown(signal: string) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    clearInterval(guestCleanupTimer);
    server.stop();
    await shutdownAllHomes();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
