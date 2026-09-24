// test-env sets EIGEN_DATA_ROOT before the app/auth imports below open their SQLite files. Keep it first.
import './test-env';
import { afterAll } from 'bun:test';
import { clearSucroseCache } from 'elysia/sucrose';
import { shutdownAllHomes } from '../lib/home';
import { cleanup } from './setup';

// Every file runs in a fresh global (--isolate), so this hook runs once per file. An unref'd timer still
// holds its callback until it fires, and two of them reach the whole module graph: each Home's idle
// timeout (5 min) and Elysia's sucrose cache sweep (4 min 55 s, armed by the first lifecycle hook). Both
// must go or every file's graph stays resident. On CI the worker's size lands next to each file's output.
afterAll(async () => {
    await shutdownAllHomes();
    clearSucroseCache(0);
    cleanup();
    if (process.env['GITHUB_ACTIONS']) {
        const worker = process.env['BUN_TEST_WORKER_ID'] ?? '0';
        console.log(`[memory] worker ${worker} rss ${Math.round(process.memoryUsage.rss() / 1048576)}MB`);
    }
});
