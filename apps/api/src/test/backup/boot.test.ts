import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILED_RESTORE_SUFFIX, getBackupsDir, PRE_RESTORE_SUFFIX, wipeBackupStaging } from '../../lib/backup/paths';
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

    function seedFolder(name: string, content: string): string {
        const dir = join(homeRoot, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'marker'), content);
        made.push(dir);
        return dir;
    }

    // What restoreHome writes before it moves a home aside, in the staging folder of its job.
    function seedRestoringMarker(jobId: string, homeName: string, preRestoreName: string): void {
        const dir = join(getBackupsDir(), '.staging', jobId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({ ownerId: homeName, homeDir: join(homeRoot, homeName), preRestoreName }),
        );
        made.push(dir);
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

    test('the marker of an interrupted restore puts its home folder back', () => {
        const id = 'bootrecoverAAAAAAAAAAAAAAAAAAAAA';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000100`;
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'an older restore');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-a', id, aside);
        made.push(join(homeRoot, id));

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        // Only the folder the marker names moves; an older copy stays for the admin to delete.
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
        expect(existsSync(join(homeRoot, aside))).toBe(false);
    });

    // A safety-copy restore killed mid-swap leaves the same shape (both restores write the marker
    // through one code path, replaceHomeFolder) with nothing else in its staging folder: no unpacked
    // archive, just the note.
    test('the marker an interrupted safety-copy restore leaves puts the home back', () => {
        const id = 'bootrecoverFFFFFFFFFFFFFFFFFFFFF';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260202-000000`;
        seedFolder(aside, 'the home mid-swap');
        seedRestoringMarker('boot-job-d', id, aside);
        made.push(join(homeRoot, id));

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home mid-swap');
        expect(existsSync(join(homeRoot, aside))).toBe(false);
    });

    // delete-user.ts removes the live home folder and nothing else;    // delete-user.ts removes the live home folder and nothing else; the safety copies of a user who
    // was deleted stay behind forever. A missing home folder is therefore not evidence of anything.
    test('a safety copy left by a deleted user is not resurrected', () => {
        const id = 'bootrecoverDDDDDDDDDDDDDDDDDDDDD';
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'the deleted user');

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });

    test('a marker whose home folder is there changes nothing', () => {
        const id = 'bootrecoverBBBBBBBBBBBBBBBBBBBBB';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(id, 'live');
        seedFolder(aside, 'aside');
        seedRestoringMarker('boot-job-b', id, aside);

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('live');
        expect(existsSync(join(homeRoot, aside))).toBe(true);
    });

    test('a marker naming a folder of another home is refused', () => {
        const id = 'bootrecoverCCCCCCCCCCCCCCCCCCCCC';
        const other = 'bootrecoverEEEEEEEEEEEEEEEEEEEEE';
        const aside = `${other}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(aside, 'somebody else');
        seedFolder(`${id}${FAILED_RESTORE_SUFFIX}20260101-000000`, 'failed');
        seedRestoringMarker('boot-job-c', id, aside);

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(existsSync(join(homeRoot, aside))).toBe(true);
        expect(existsSync(join(homeRoot, `${id}${FAILED_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });
});
