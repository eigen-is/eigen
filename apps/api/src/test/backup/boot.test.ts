import { afterAll, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import {
    buildArtifactName,
    buildRestoreStagingDir,
    buildServerArchiveName,
    getBackupsDir,
    serverSidecarPath,
    sidecarPath,
    wipeBackupStaging,
} from '../../lib/backup/paths';
import { recoverBackupsAfterRestart, recoverInterruptedRestores } from '../../lib/backup/recovery';
import { TEST_DATA_DIR } from '../setup';

// What the server does before it serves its first request: clear the staging folder a killed job
// left behind, and put back the home folder of a restore that died between the move-aside and the
// install. Both run at module scope in server.ts, so neither may throw and neither may create a
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

    // What a restore writes before it moves a home aside, in the folder its job staged beside the home — and,
    // when the install got all the way through, the note it writes beside it. `preRestoreName` is
    // null for a restore of a deleted user: there was no home folder to move aside. `parkName` is a
    // `.failed-restore-` name unless a safety-copy restore gives its copy's own. `dir` is where a build up to 0.4.1
    // kept them when given.
    function seedRestoringMarker(
        jobId: string,
        homeName: string,
        preRestoreName: string | null,
        complete = false,
        parkName = `${homeName}${FAILED_RESTORE_SUFFIX}20261231-235959`,
        dir = buildRestoreStagingDir(join(homeRoot, homeName), jobId),
    ): string {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({
                ownerId: homeName,
                homeDir: join(homeRoot, homeName),
                preRestoreName,
                parkName,
            }),
        );
        if (complete) writeFileSync(join(dir, 'restore-complete.json'), JSON.stringify({ completedAt: 'seeded' }));
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

    // A build before 0.4.1 wrote a home archive and its sidecar with the umask's mode. ./eigen reads a server
    // archive's sidecar as the operator, so that one stays as it is.
    test('the boot closes the home archives and home sidecars an older build left readable', async () => {
        const dir = join(TEST_DATA_DIR, 'backups-modes');
        const at = new Date('2026-10-01T12:00:00Z');
        const archive = join(dir, buildArtifactName('bootmodesAAAAAAAAAAAAAAAAAAAAAAA', at));
        // A sidecar whose archive is gone still names every file of the home.
        const orphanSidecar = sidecarPath(join(dir, buildArtifactName('bootmodesBBBBBBBBBBBBBBBBBBBBBBB', at)));
        const serverSidecar = serverSidecarPath(join(dir, buildServerArchiveName('manual', 'full', at)));
        // A symlink named as an archive, to a file outside the backups folder that is not the server's to close.
        const elsewhere = join(TEST_DATA_DIR, 'backups-modes-elsewhere');
        const linked = join(dir, buildArtifactName('bootmodesCCCCCCCCCCCCCCCCCCCCCCC', at));
        mkdirSync(dir, { recursive: true });
        for (const file of [archive, sidecarPath(archive), orphanSidecar, serverSidecar, elsewhere]) {
            writeFileSync(file, '{}');
            chmodSync(file, 0o644);
        }
        symlinkSync(elsewhere, linked);
        const previous = process.env['EIGEN_BACKUPS_DIR'];
        process.env['EIGEN_BACKUPS_DIR'] = dir;
        try {
            await recoverBackupsAfterRestart();
            const modeOf = (file: string) => statSync(file).mode & 0o777;
            expect([archive, sidecarPath(archive), orphanSidecar].map(modeOf)).toEqual([0o600, 0o600, 0o600]);
            expect(modeOf(serverSidecar)).toBe(0o644);
            expect(modeOf(elsewhere)).toBe(0o644);
        } finally {
            if (previous === undefined) delete process.env['EIGEN_BACKUPS_DIR'];
            else process.env['EIGEN_BACKUPS_DIR'] = previous;
            rmSync(dir, { recursive: true, force: true });
            rmSync(elsewhere, { force: true });
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

    // The install renames the unpacked home into place, and the restore writes its completion note
    // only after the data epoch rotates. A folder that is there without the note is one the restore
    // had not finished with, and is not trusted as a home.
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

    // A safety-copy restore renames the copy into place before its checks, so a kill there leaves a pristine home at
    // the home's path. It goes back under its own name: a `.failed-restore-` one could only be deleted.
    test('a marker of a safety-copy restore parks the copy under its own name and puts the home back', () => {
        const id = 'bootrecoverIIIIIIIIIIIIIIIIIIIII';
        const copy = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000100`;
        seedFolder(id, 'the copy, put in place');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-i', id, aside, false, copy);
        made.push(join(homeRoot, copy));

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, copy, 'marker'), 'utf8')).toBe('the copy, put in place');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
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

    // A per-home restore unpacks beside the home, and a kill before its job ended leaves that folder. Nothing resumes it.
    test('the boot removes the folders killed restores were unpacking into, and leaves the homes beside them', async () => {
        const id = 'bootrecoverJJJJJJJJJJJJJJJJJJJJJ';
        seedFolder(id, 'the home');
        const staged = [
            buildRestoreStagingDir(join(homeRoot, id), 'boot-job-j'),
            buildRestoreStagingDir(join(TEST_DATA_DIR, 'team', 'bootrecoverTeamJJJJJJJJJJJJJJJJJ'), 'boot-job-k'),
        ];
        for (const dir of staged) {
            mkdirSync(join(dir, `home-${id}`, 'home'), { recursive: true });
            made.push(dir);
        }

        await recoverBackupsAfterRestart();

        expect(staged.filter(existsSync)).toEqual([]);
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home');
    });

    // The home went aside and the staged one did not move in yet: the marker puts the old one back, and the staged one
    // goes with the other leftovers.
    test('a kill between the two renames of the swap puts the home as it was back', async () => {
        const id = 'bootrecoverLLLLLLLLLLLLLLLLLLLLL';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260404-000000`;
        seedFolder(aside, 'the home as it was');
        const staged = seedRestoringMarker('boot-job-l', id, aside);
        mkdirSync(join(staged, `home-${id}`, 'home'), { recursive: true });
        writeFileSync(join(staged, `home-${id}`, 'home', 'marker'), 'the restored home');
        made.push(join(homeRoot, id));

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(join(homeRoot, aside))).toBe(false);
        expect(existsSync(staged)).toBe(false);
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
    });

    // A build up to 0.4.1 kept the notes in backups/.staging. One release still reads them, so an upgrade right after a
    // killed restore recovers it.
    test('the notes an older build kept in the backups folder are still read', async () => {
        const id = 'bootrecoverMMMMMMMMMMMMMMMMMMMMM';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260505-000000`;
        seedFolder(id, 'half-written');
        seedFolder(aside, 'the home as it was');
        const parkName = `${id}${FAILED_RESTORE_SUFFIX}20260505-000000`;
        seedRestoringMarker('boot-job-m', id, aside, false, parkName, join(getBackupsDir(), '.staging', 'boot-job-m'));
        made.push(join(homeRoot, parkName));

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, parkName, 'marker'), 'utf8')).toBe('half-written');
        expect(existsSync(join(getBackupsDir(), '.staging'))).toBe(false);
    });
});
