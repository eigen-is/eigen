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
// The explicit deadline keeps a stuck teardown from hiding behind the run's default; a slow one is
// named here, since Bun reports a hook timeout as "(unnamed)" with no file.
afterAll(async () => {
    const start = Bun.nanoseconds();
    await shutdownAllHomes();
    const ms = (Bun.nanoseconds() - start) / 1_000_000;
    if (ms > 1_000) console.warn(`[preload] shutdownAllHomes took ${ms.toFixed(0)}ms`);
    clearSucroseCache(0);
    cleanup();
    if (process.env['GITHUB_ACTIONS']) {
        const worker = process.env['BUN_TEST_WORKER_ID'] ?? '0';
        console.log(`[memory] worker ${worker} rss ${Math.round(process.memoryUsage.rss() / 1048576)}MB`);
    }
}, 30_000);
