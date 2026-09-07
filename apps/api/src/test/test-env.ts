import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Sets EIGEN_DATA_ROOT before anything imports the app/auth modules, which open their SQLite files at
// module-eval. Imported first by setup.ts. Each worker process (bun test --parallel) gets its own run
// dir, so no worker ever unlinks another's open databases.
const TEST_DATA_ROOT = join(import.meta.dir, '../../../../data-test');
const STALE_MS = 60 * 60 * 1000;

mkdirSync(TEST_DATA_ROOT, { recursive: true });

// Prune leftovers from crashed or old runs without ever touching a live sibling's dir. Many unit tests
// keep their own `data-test/test-<name>-<ts>` dir and clean it in afterAll, so under --parallel we must
// remove only what is safe: our own `test-<pid>-` dirs whose worker is gone, plus anything older than an
// hour (a run finishes in minutes, so a fresh concurrent dir is always younger than that).
for (const name of readdirSync(TEST_DATA_ROOT)) {
    const dir = join(TEST_DATA_ROOT, name);
    let stale: boolean;
    try {
        stale = Date.now() - statSync(dir).mtimeMs > STALE_MS;
    } catch {
        continue;
    }
    const pid = /^test-(\d+)-/.exec(name)?.[1];
    if (pid && !stale) {
        try {
            process.kill(Number(pid), 0);
            continue; // live worker of ours — leave it alone
        } catch {
            // worker gone — safe to remove
        }
    } else if (!stale) {
        continue; // another test's fresh dir — not ours to remove
    }
    rmSync(dir, { recursive: true, force: true });
}

export const TEST_DATA_DIR = mkdtempSync(join(TEST_DATA_ROOT, `test-${process.pid}-`));
process.env['EIGEN_DATA_ROOT'] = TEST_DATA_DIR;
process.env['API_URL'] = 'http://localhost';

mkdirSync(join(TEST_DATA_DIR, 'server'), { recursive: true });
mkdirSync(join(TEST_DATA_DIR, 'home'), { recursive: true });
