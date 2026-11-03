import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import {
    chmodSync,
    createWriteStream,
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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import * as archiveModule from '../../lib/backup/archive';
import {
    buildArtifactName,
    buildRestoreStagingDir,
    buildServerArchiveName,
    getBackupsDir,
    serverSidecarPath,
    sidecarPath,
    wipeBackupStaging,
} from '../../lib/backup/paths';
import * as recoveryModule from '../../lib/backup/recovery';
import {
    recoverBackupsAfterRestart,
    recoverInterruptedRestores,
    wipeRestoreStagingDir,
} from '../../lib/backup/recovery';
import { restoreHome } from '../../lib/backup/restore';
import { archiveEnd, DIRECTORY_TYPEFLAG, FILE_TYPEFLAG, headerChunks, padding } from '../../lib/backup/tar';
import { clearHomeRestoring, openHome } from '../../lib/home/get-home';
import { ensureServer, TEST_DATA_DIR } from '../setup';

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

    // A build before 0.4.1 wrote a home archive and its sidecar with the umask's mode, and one before 0.4.2 a server
    // archive's sidecar.
    test('the boot closes the archives and sidecars an older build left readable', async () => {
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
            expect([archive, sidecarPath(archive), orphanSidecar, serverSidecar].map(modeOf)).toEqual([
                0o600, 0o600, 0o600, 0o600,
            ]);
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

    // A folder already under the park name, such as the one a rollback parked before it failed, takes no rename on
    // top of it. Both folders stay for the operator, and the boot goes on to the next home: a throw here would stop
    // the server from starting at all.
    test('a park name already taken leaves both folders and the boot goes on', () => {
        const id = 'bootrecoverJJJJJJJJJJJJJJJJJJJJJ';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        const parkName = `${id}${FAILED_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(id, 'made since');
        seedFolder(aside, 'the home as it was');
        seedFolder(parkName, 'parked by the rollback');
        seedRestoringMarker('boot-job-j', id, aside, false, parkName);
        const other = 'bootrecoverKKKKKKKKKKKKKKKKKKKKK';
        const otherAside = `${other}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(otherAside, 'the other home');
        seedRestoringMarker('boot-job-k', other, otherAside);
        made.push(join(homeRoot, other));
        const logged = spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => recoverInterruptedRestores()).not.toThrow();
            expect(logged.mock.calls.flat().join('\n')).toContain(parkName);
        } finally {
            logged.mockRestore();
        }

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('made since');
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, parkName, 'marker'), 'utf8')).toBe('parked by the rollback');
        expect(readFileSync(join(homeRoot, other, 'marker'), 'utf8')).toBe('the other home');
    });

    // A home whose folders cannot be moved, such as a rename that fails with EACCES or EBUSY, must not stop the
    // server from starting, again on every boot. It is logged, its notes stay for the next boot, and the boot goes
    // on to the next home. The home answers 503 until then: a request would make a new home folder at its path.
    test('a home whose rename throws keeps its notes, stays shut, and the boot goes on', async () => {
        const id = 'bootrecoverOOOOOOOOOOOOOOOOOOOOO';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(aside, 'the home as it was');
        const notes = seedRestoringMarker('boot-job-l', id, aside);
        made.push(join(homeRoot, id));
        const other = 'bootrecoverPPPPPPPPPPPPPPPPPPPPP';
        const otherAside = `${other}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(otherAside, 'the other home');
        seedRestoringMarker('boot-job-m', other, otherAside);
        made.push(join(homeRoot, other));
        const rename = nodeFs.renameSync;
        const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            if (to === join(homeRoot, id)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            rename(from, to);
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => recoverInterruptedRestores()).not.toThrow();
            const said = logged.mock.calls.flat().join('\n');
            expect(said).toContain(join(homeRoot, id));
            expect(said).toContain(notes);
            expect(said).toContain('./eigen stop, then ./eigen restart');
        } finally {
            renameSpy.mockRestore();
            logged.mockRestore();
        }

        expect(existsSync(join(notes, 'restoring.json'))).toBe(true);
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, other, 'marker'), 'utf8')).toBe('the other home');
        await expect(openHome(id)).rejects.toThrow('Restore in progress');
        // The next boot, whose rename works, puts the home back. It starts with no home marked.
        clearHomeRestoring(id);
        recoverInterruptedRestores();
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(notes)).toBe(false);
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

    // The job removes its folder once the home serves. A kill partway through that removal must not leave the marker
    // without its completion note, or the next boot would undo a restore the user has worked in since. An unremovable
    // folder inside stands in for the kill: the removal fails there, after it has started. Root removes it anyway.
    test.skipIf(process.getuid?.() === 0)(
        'a removal of a finished restore cut off partway leaves no marker for a later boot',
        async () => {
            const id = 'bootrecoverNNNNNNNNNNNNNNNNNNNNN';
            const aside = `${id}${PRE_RESTORE_SUFFIX}20260606-000000`;
            const homeDir = seedFolder(id, 'the restored home');
            seedFolder(aside, 'the home as it was');
            const staged = seedRestoringMarker('boot-job-n', id, aside, true);
            const locked = join(staged, `home-${id}`, 'home');
            mkdirSync(locked, { recursive: true });
            writeFileSync(join(locked, 'kept'), '');
            chmodSync(locked, 0o500);
            try {
                await expect(wipeRestoreStagingDir(homeDir, 'boot-job-n')).rejects.toThrow();
            } finally {
                chmodSync(locked, 0o700);
            }
            // What the removal got through before the kill could include the completion note.
            rmSync(join(staged, 'restore-complete.json'), { force: true });

            expect(existsSync(join(staged, 'restoring.json'))).toBe(false);
            recoverInterruptedRestores();
            expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the restored home');
            expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        },
    );

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

    // The notes name the home by the path it had when they were written. A data folder moved since, such as to
    // another disk, still recovers: the home is the one beside the notes.
    test('the notes of a restore recover the home after the data folder moved', () => {
        const id = 'bootmovedAAAAAAAAAAAAAAAAAAAAAAA';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260707-000000`;
        seedFolder(aside, 'the home as it was');
        const dir = seedRestoringMarker('boot-job-moved', id, aside);
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({
                ownerId: id,
                homeDir: join('/old/disk/data/home', id),
                preRestoreName: aside,
                parkName: `${id}${FAILED_RESTORE_SUFFIX}20260707-000000`,
            }),
        );
        made.push(join(homeRoot, id));

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
    });

    // Every name the notes give must be of the home they sit beside: its owner id, and the homes folder of its kind.
    test('notes whose owner or folder is not the home beside them are refused', () => {
        const id = 'bootforeignAAAAAAAAAAAAAAAAAAAAA';
        const other = 'bootforeignBBBBBBBBBBBBBBBBBBBBB';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260808-000000`;
        seedFolder(aside, 'the home as it was');
        const notes = [
            { ownerId: other, homeDir: join(homeRoot, id) },
            { ownerId: id, homeDir: join(TEST_DATA_DIR, 'team', id) },
            { ownerId: `team_${id}`, homeDir: join(homeRoot, id) },
        ];
        for (const [index, note] of notes.entries()) {
            const dir = seedRestoringMarker(`boot-job-foreign-${index}`, id, aside);
            writeFileSync(
                join(dir, 'restoring.json'),
                JSON.stringify({
                    ...note,
                    preRestoreName: aside,
                    parkName: `${id}${FAILED_RESTORE_SUFFIX}20260808-000000`,
                }),
            );
        }

        recoverInterruptedRestores();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
    });

    // The notes an older build kept in the backups folder name the home by its full path, so it must be in data/.
    test('older notes that name a home outside the data folder are refused', async () => {
        const id = 'bootoutsideAAAAAAAAAAAAAAAAAAAAA';
        const elsewhere = join(TEST_DATA_DIR, 'elsewhere', 'home');
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260909-000000`;
        mkdirSync(join(elsewhere, aside), { recursive: true });
        made.push(join(TEST_DATA_DIR, 'elsewhere'));
        const dir = join(getBackupsDir(), '.staging', 'boot-job-outside');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({
                ownerId: id,
                homeDir: join(elsewhere, id),
                preRestoreName: aside,
                parkName: `${id}${FAILED_RESTORE_SUFFIX}20260909-000000`,
            }),
        );

        await recoverBackupsAfterRestart();

        expect(existsSync(join(elsewhere, id))).toBe(false);
        expect(existsSync(join(elsewhere, aside))).toBe(true);
    });

    // An archive's own top-level files land where the restore unpacks it. A `restoring.json` among them must not be
    // read as the job's note by the boot after a kill in the unpack, or it moves another user's home aside.
    test("an archive's own restoring.json is not read as the job's note at boot", async () => {
        await ensureServer();
        const archived = 'bootplantedAAAAAAAAAAAAAAAAAAAAA';
        const victim = 'bootplantedVVVVVVVVVVVVVVVVVVVVV';
        seedFolder(victim, 'the victim home');
        const planted = JSON.stringify({
            ownerId: victim,
            homeDir: join(homeRoot, victim),
            preRestoreName: null,
            parkName: `${victim}${FAILED_RESTORE_SUFFIX}20200101-000000`,
        });
        const manifest: BackupManifest = {
            formatVersion: 1,
            kind: 'user',
            ownerId: archived,
            name: 'planted',
            createdAt: new Date().toISOString(),
            appVersion: 'test',
            server: { domain: 'test', orgId: 'test' },
            counts: { databases: 0, files: 0, bytes: 0, dirs: 1 },
            mounts: [],
            entries: [],
        };
        const artifact = buildArtifactName(archived, new Date('2026-01-01T00:00:00Z'));
        const artifactPath = join(getBackupsDir(), artifact);
        const files: [string, string][] = [
            [`home-${archived}/manifest.json`, JSON.stringify(manifest)],
            ['restoring.json', planted],
        ];
        await pipeline(Readable.from(tarOf(files)), createZstdCompress(), createWriteStream(artifactPath));
        const jobId = 'boot-job-planted';
        made.push(buildRestoreStagingDir(join(homeRoot, archived), jobId), artifactPath);
        // The kill comes right after the unpack, so the job never removes its folder.
        const killed = spyOn(archiveModule, 'readUnpackedHome').mockImplementation(() => {
            throw new Error('killed');
        });
        const kept = spyOn(recoveryModule, 'wipeRestoreStagingDir').mockImplementation(async () => {});
        try {
            await expect(restoreHome(artifact, archived, jobId)).rejects.toThrow('killed');
        } finally {
            killed.mockRestore();
            kept.mockRestore();
        }

        recoverInterruptedRestores();

        expect(readFileSync(join(homeRoot, victim, 'marker'), 'utf8')).toBe('the victim home');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${victim}${FAILED_RESTORE_SUFFIX}`))).toEqual(
            [],
        );
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

    // An older build's notes whose rename throws stay too, so the backups folder's staging is not wiped over them,
    // and the home answers 503 until a later boot puts it back.
    test('the notes an older build kept stay when their rename throws, and the home stays shut', async () => {
        const id = 'bootrecoverQQQQQQQQQQQQQQQQQQQQQ';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260606-000000`;
        seedFolder(id, 'half-written');
        seedFolder(aside, 'the home as it was');
        const parkName = `${id}${FAILED_RESTORE_SUFFIX}20260606-000000`;
        const notes = seedRestoringMarker(
            'boot-job-q',
            id,
            aside,
            false,
            parkName,
            join(getBackupsDir(), '.staging', 'boot-job-q'),
        );
        made.push(join(homeRoot, parkName));
        const rename = nodeFs.renameSync;
        const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            if (to === join(homeRoot, id)) throw Object.assign(new Error('device busy'), { code: 'EBUSY' });
            rename(from, to);
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});

        try {
            await recoverBackupsAfterRestart();
            const said = logged.mock.calls.flat().join('\n');
            expect(said).toContain(join(homeRoot, id));
            expect(said).toContain(notes);
            expect(said).toContain('./eigen stop, then ./eigen restart');
        } finally {
            renameSpy.mockRestore();
            logged.mockRestore();
        }

        expect(existsSync(join(notes, 'restoring.json'))).toBe(true);
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        await expect(openHome(id)).rejects.toThrow('Restore in progress');
        // The next boot, whose rename works, puts the home back. It starts with no home marked.
        clearHomeRestoring(id);
        await recoverBackupsAfterRestart();
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, parkName, 'marker'), 'utf8')).toBe('half-written');
        expect(existsSync(join(getBackupsDir(), '.staging'))).toBe(false);
    });
});

// A tar of the given files under the first one's root folder, as a crafted archive might hold them.
function* tarOf(files: [name: string, text: string][]): Generator<Uint8Array> {
    let written = 0;
    function* counted(chunks: Iterable<Uint8Array>): Generator<Uint8Array> {
        for (const chunk of chunks) {
            written += chunk.length;
            yield chunk;
        }
    }
    const root = files[0]?.[0].split('/')[0] ?? 'root';
    yield* counted(headerChunks(`${root}/`, 0, Date.now(), DIRECTORY_TYPEFLAG, 0o700));
    for (const [name, text] of files) {
        const body = Buffer.from(text);
        yield* counted(headerChunks(name, body.length, Date.now(), FILE_TYPEFLAG, 0o600));
        yield* counted([body, padding(body.length)]);
    }
    yield* archiveEnd(written);
}
