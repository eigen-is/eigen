import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILED_RESTORE_SUFFIX, getBackupsDir, PRE_RESTORE_SUFFIX, wipeBackupStaging } from '../../lib/backup/paths';
import { recoverInterruptedRestores } from '../../lib/backup/recovery';
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

    // What restoreHome writes before it moves a home aside, in the staging folder of its job — and,
    // when the install got all the way through, the note it writes beside it. `preRestoreName` is
    // null for a restore of a deleted user: there was no home folder to move aside.
    function seedRestoringMarker(
        jobId: string,
        homeName: string,
        preRestoreName: string | null,
        complete = false,
    ): void {
        const dir = join(getBackupsDir(), '.staging', jobId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({ ownerId: homeName, homeDir: join(homeRoot, homeName), preRestoreName }),
        );
        if (complete) writeFileSync(join(dir, 'restore-complete.json'), JSON.stringify({ completedAt: 'seeded' }));
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

    // delete-user.ts removes the live home folder and nothing else; the safety copies of a user who
    // was deleted stay behind forever. A missing home folder is therefore not evidence of anything.
    test('a safety copy left by a deleted user is not resurrected', () => {
        const id = 'bootrecoverDDDDDDDDDDDDDDDDDDDDD';
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'the deleted user');

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });

    // The install creates the home folder early (a rename of the extracted `home/`, or a whole copy
    // when the backups folder is on another disk) and keeps writing to it for as long as the
    // materialization, the checks and the identity writes take. A folder that is there without the
    // completion note is somewhere in the middle of that, and is not a home.
    test('a marker with a half-written home folder parks it and puts the copy back', () => {
        const id = 'bootrecoverBBBBBBBBBBBBBBBBBBBBB';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(id, 'half-written');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-b', id, aside);

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(join(homeRoot, aside))).toBe(false);
        // Nothing is deleted: the half-written folder keeps a name of its own, the one a failure the
        // job caught itself would have left.
        const parked = readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`));
        expect(parked.length).toBe(1);
        expect(readFileSync(join(homeRoot, parked[0], 'marker'), 'utf8')).toBe('half-written');
        made.push(join(homeRoot, parked[0]));
    });

    // A restore of a deleted user has no folder to move aside, so there is nothing to put back —
    // but the folder the install was writing is still not a home, and only the marker says so.
    test('a marker with no pre-restore copy parks the half-written home', () => {
        const id = 'bootrecoverHHHHHHHHHHHHHHHHHHHHH';
        seedFolder(id, 'half-written, no copy');
        seedRestoringMarker('boot-job-f', id, null);

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        const parked = readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`));
        expect(parked.length).toBe(1);
        expect(readFileSync(join(homeRoot, parked[0], 'marker'), 'utf8')).toBe('half-written, no copy');
        made.push(join(homeRoot, parked[0]));
    });

    test('a marker whose restore finished changes nothing', () => {
        const id = 'bootrecoverGGGGGGGGGGGGGGGGGGGGG';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260303-000000`;
        seedFolder(id, 'the restored home');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-e', id, aside, true);

        recoverInterruptedRestores();

        // The install wrote its completion note, so the home in place is the restored one and the
        // copy beside it is the safety copy the admin decides about.
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the restored home');
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
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
