import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Sets EIGEN_DATA_ROOT before anything imports the app/auth modules, which open their SQLite files at
// module-eval. Imported first by setup.ts. Each worker process (bun test --parallel) gets its own run
// dir, so no worker ever unlinks another's open databases.
const TEST_DATA_ROOT = join(import.meta.dir, '../../../../data-test');
// A run finishes in a couple of minutes, so anything older than this is certainly from a dead run and safe
// to delete — while a live worker's dir (created seconds ago) is never old enough to be touched.
const STALE_MS = 10 * 60 * 1000;

mkdirSync(TEST_DATA_ROOT, { recursive: true });

// Prune only long-dead leftovers, by age alone. Under --parallel many workers share this root — each has
// its own `test-<pid>-<rand>` run dir (below) and many unit tests keep their own `test-<name>-<ts>` scratch
// dir — so deleting anything young would race a peer that still holds its SQLite files open (the EFAULT /
// ENOENT "unhandled error between tests" failures). Age alone never selects a live dir.
//
// Under --parallel every test file re-runs this preload in a fresh module graph and process.env, so the
// sweep runs once per file; the age gate keeps that safe. rmSync is wrapped: two workers can select the same
// stale dir and one loses the race.
const now = Date.now();
for (const name of readdirSync(TEST_DATA_ROOT)) {
    const dir = join(TEST_DATA_ROOT, name);
    try {
        if (now - statSync(dir).mtimeMs <= STALE_MS) continue;
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // vanished mid-walk, or a peer worker removed it first — nothing to do
    }
}

export const TEST_DATA_DIR = mkdtempSync(join(TEST_DATA_ROOT, `test-${process.pid}-`));
process.env['EIGEN_DATA_ROOT'] = TEST_DATA_DIR;
// Backup artifacts live outside the data root in production; inside the run dir here, so parallel
// workers never share a backups folder and the run's leftovers are pruned with everything else.
process.env['EIGEN_BACKUPS_DIR'] = join(TEST_DATA_DIR, 'backups');
process.env['API_URL'] = 'http://localhost';

mkdirSync(join(TEST_DATA_DIR, 'server'), { recursive: true });
mkdirSync(join(TEST_DATA_DIR, 'home'), { recursive: true });
