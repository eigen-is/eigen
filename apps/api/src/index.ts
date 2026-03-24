import {app} from "./app";
import {shutdownAllHomes} from "./lib/home";

const server = app.listen(8000);

export type {App as app} from "./app";

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

async function gracefulShutdown(signal: string) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    server.stop();
    await shutdownAllHomes();
    console.log('All homes shut down, exiting.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
