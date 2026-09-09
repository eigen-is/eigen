import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX, wipeBackupStaging } from '../../lib/backup/paths';
import { recoverInterruptedRestores } from '../../lib/backup/restore';
import { TEST_DATA_DIR } from '../setup';

// What the server does before it serves its first request: clear the staging folder a killed job
// left behind, and put back the home folder of a restore that died between the move-aside and the
// install. Both run at module scope in index.ts, so neither may throw and neither may create a
// folder the deployment did not ask for — in the container the backups path is a bind mount the
// API runs as an unprivileged user next to.
describe('Backup boot', () => {
    const homeRoot = join(TEST_DATA_DIR, 'home');
    const made: string[] = [];

    function seedFolder(name: string, marker: string): string {
        const dir = join(homeRoot, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'marker'), marker);
        made.push(dir);
        return dir;
    }

    afterAll(() => {
        for (const dir of made) rmSync(dir, { recursive: true, force: true });
    });

    test('the staging wipe creates nothing when the backups folder is absent', () => {
        const absent = join(TEST_DATA_DIR, 'backups-absent');
        const previous = process.env['EIGEN_BACKUPS_DIR'];
        process.env['EIGEN_BACKUPS_DIR'] = absent;
        try {
            expect(() => wipeBackupStaging()).not.toThrow();
            expect(existsSync(absent)).toBe(false);
        } finally {
            if (previous === undefined) delete process.env['EIGEN_BACKUPS_DIR'];
            else process.env['EIGEN_BACKUPS_DIR'] = previous;
        }
    });

    test('the staging wipe clears a folder a killed job left behind', () => {
        const dir = join(TEST_DATA_DIR, 'backups-wipe');
        const staging = join(dir, '.staging', 'job-1');
        mkdirSync(staging, { recursive: true });
        const previous = process.env['EIGEN_BACKUPS_DIR'];
        process.env['EIGEN_BACKUPS_DIR'] = dir;
        try {
            wipeBackupStaging();
            expect(existsSync(join(dir, '.staging'))).toBe(false);
            expect(existsSync(dir)).toBe(true);
        } finally {
            if (previous === undefined) delete process.env['EIGEN_BACKUPS_DIR'];
            else process.env['EIGEN_BACKUPS_DIR'] = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an interrupted restore gets its newest safety copy back as the home folder', () => {
        const id = 'bootrecoverAAAAAAAAAAAAAAAAAAAAA';
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'older');
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000100`, 'newer');
        made.push(join(homeRoot, id));

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('newer');
        // Only the copy that was put back moves; an older one stays for the admin to delete.
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000100`))).toBe(false);
    });

    test('a safety copy beside a home that is there is left alone', () => {
        const id = 'bootrecoverBBBBBBBBBBBBBBBBBBBBB';
        seedFolder(id, 'live');
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'aside');

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('live');
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });

    test('a failed restore is left where it is', () => {
        const id = 'bootrecoverCCCCCCCCCCCCCCCCCCCCC';
        seedFolder(`${id}${FAILED_RESTORE_SUFFIX}20260101-000000`, 'failed');

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(existsSync(join(homeRoot, `${id}${FAILED_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });
});
