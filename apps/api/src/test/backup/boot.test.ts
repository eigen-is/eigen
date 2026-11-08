import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import * as archiveModule from '../../lib/backup/archive';
import { buildRestoreStagingDir, freeArtifactName, getBackupsDir, wipeBackupStaging } from '../../lib/backup/paths';
import * as recoveryModule from '../../lib/backup/recovery';
import { dropRestoringMarker, recoverBackupsAfterRestart } from '../../lib/backup/recovery';
import { restoreHome } from '../../lib/backup/restore';
import { archiveEnd, DIRECTORY_TYPEFLAG, FILE_TYPEFLAG, headerChunks, padding } from '../../lib/backup/tar';
import { clearHomeRestoring, openHome } from '../../lib/home/get-home';
import { ensureServer, TEST_DATA_DIR } from '../setup';

// What the server does before it serves its first request: clear the staging folder a killed job
// left behind, and put back the home folder of a restore that died between the move-aside and the
// install. Both run at module scope in server.ts, so neither may stop the boot and neither may create a
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

    // What a restore writes before it moves a home aside, in the folder its job staged beside the home. `preRestoreName`
    // is null for a restore of a deleted user: there was no home folder to move aside. `parkName` is a
    // `.failed-restore-` name unless a safety-copy restore gives its copy's own.
    function seedRestoringMarker(
        jobId: string,
        homeName: string,
        preRestoreName: string | null,
        parkName = `${homeName}${FAILED_RESTORE_SUFFIX}20261231-235959`,
    ): string {
        const dir = buildRestoreStagingDir(join(homeRoot, homeName), jobId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'restoring.json'),
            JSON.stringify({
                ownerId: homeName,
                preRestoreName,
                parkName,
            }),
        );
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

    // A backups/ whose mount is down, or a .staging that cannot be emptied, must not keep the API from starting.
    test('a staging wipe that throws leaves the boot going, and says so', async () => {
        const rm = nodeFs.rmSync;
        const rmSpy = spyOn(nodeFs, 'rmSync').mockImplementation((target, options) => {
            if (String(target).endsWith('.staging')) {
                throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
            }
            rm(target, options);
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await recoverBackupsAfterRestart();
            expect(logged.mock.calls.flat().join('\n')).toContain('directory not empty');
        } finally {
            rmSpy.mockRestore();
            logged.mockRestore();
        }
    });

    test('a homes folder that does not read leaves the boot going, and says so', async () => {
        const readSpy = spyOn(nodeFs, 'readdirSync').mockImplementation(() => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await recoverBackupsAfterRestart();
            expect(logged.mock.calls.flat().join('\n')).toContain('permission denied');
        } finally {
            readSpy.mockRestore();
            logged.mockRestore();
        }
    });

    test('the marker of an interrupted restore puts its home folder back', async () => {
        const id = 'bootrecoverAAAAAAAAAAAAAAAAAAAAA';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000100`;
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'an older restore');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-a', id, aside);
        made.push(join(homeRoot, id));

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        // Only the folder the marker names moves; an older copy stays for the admin to delete.
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
        expect(existsSync(join(homeRoot, aside))).toBe(false);
    });

    // A safety-copy restore killed mid-swap leaves the same shape (both restores write the marker
    // through one code path, replaceHomeFolder) with nothing else in its staging folder: no unpacked
    // archive, just the note.
    test('the marker an interrupted safety-copy restore leaves puts the home back', async () => {
        const id = 'bootrecoverFFFFFFFFFFFFFFFFFFFFF';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260202-000000`;
        seedFolder(aside, 'the home mid-swap');
        seedRestoringMarker('boot-job-d', id, aside);
        made.push(join(homeRoot, id));

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home mid-swap');
        expect(existsSync(join(homeRoot, aside))).toBe(false);
    });

    // delete-user.ts removes the live home folder and nothing else; the safety copies of a user who
    // was deleted stay behind forever. A missing home folder is therefore not evidence of anything.
    test('a safety copy left by a deleted user is not resurrected', async () => {
        const id = 'bootrecoverDDDDDDDDDDDDDDDDDDDDD';
        seedFolder(`${id}${PRE_RESTORE_SUFFIX}20260101-000000`, 'the deleted user');

        await recoverBackupsAfterRestart();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(existsSync(join(homeRoot, `${id}${PRE_RESTORE_SUFFIX}20260101-000000`))).toBe(true);
    });

    // The install renames the unpacked home into place, and the restore removes its marker only after the data epoch
    // rotates. A folder that is there beside the marker is one the restore had not finished with, and is not trusted.
    test('a marker with a half-written home folder parks it and puts the copy back', async () => {
        const id = 'bootrecoverBBBBBBBBBBBBBBBBBBBBB';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(id, 'half-written');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-b', id, aside);

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(join(homeRoot, aside))).toBe(false);
        // Nothing is deleted: the half-written folder keeps a name of its own, the one a failure the
        // job caught itself would have left.
        const parked = readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`));
        expect(parked.length).toBe(1);
        expect(readFileSync(join(homeRoot, parked[0], 'marker'), 'utf8')).toBe('half-written');
        made.push(join(homeRoot, parked[0]));
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
        expect(readFileSync(join(homeRoot, other, 'marker'), 'utf8')).toBe('the other home');
        await expect(openHome(id)).rejects.toThrow('Restore in progress');
        // The next boot, whose rename works, puts the home back. It starts with no home marked.
        clearHomeRestoring(id);
        await recoverBackupsAfterRestart();
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(existsSync(notes)).toBe(false);
    });

    // A notes folder that cannot be removed, such as with EBUSY, must not stop the server from starting either.
    test('a notes folder whose removal throws is left for the next boot, and the boot goes on', async () => {
        const id = 'bootrecoverQQQQQQQQQQQQQQQQQQQQQ';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(aside, 'the home as it was');
        const notes = seedRestoringMarker('boot-job-q', id, aside);
        made.push(join(homeRoot, id));
        const other = 'bootrecoverRRRRRRRRRRRRRRRRRRRRR';
        const otherAside = `${other}${PRE_RESTORE_SUFFIX}20260101-000000`;
        seedFolder(otherAside, 'the other home');
        seedRestoringMarker('boot-job-r', other, otherAside);
        made.push(join(homeRoot, other));
        const rm = nodeFs.rmSync;
        const rmSpy = spyOn(nodeFs, 'rmSync').mockImplementation((target, options) => {
            if (target === notes) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
            rm(target, options);
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});

        try {
            await recoverBackupsAfterRestart();
            expect(logged.mock.calls.flat().join('\n')).toContain(notes);
        } finally {
            rmSpy.mockRestore();
            logged.mockRestore();
        }

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, other, 'marker'), 'utf8')).toBe('the other home');
        await recoverBackupsAfterRestart();
        expect(existsSync(notes)).toBe(false);
    });

    // A safety-copy restore renames the copy into place before its checks, so a kill there leaves a pristine home at
    // the home's path. It goes back under its own name: a `.failed-restore-` one could only be deleted.
    test('a marker of a safety-copy restore parks the copy under its own name and puts the home back', async () => {
        const id = 'bootrecoverIIIIIIIIIIIIIIIIIIIII';
        const copy = `${id}${PRE_RESTORE_SUFFIX}20260101-000000`;
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260101-000100`;
        seedFolder(id, 'the copy, put in place');
        seedFolder(aside, 'the home as it was');
        seedRestoringMarker('boot-job-i', id, aside, copy);
        made.push(join(homeRoot, copy));

        await recoverBackupsAfterRestart();

        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readFileSync(join(homeRoot, copy, 'marker'), 'utf8')).toBe('the copy, put in place');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
    });

    // A restore of a deleted user has no folder to move aside, so there is nothing to put back —
    // but the folder the install was writing is still not a home, and only the marker says so.
    test('a marker with no pre-restore copy parks the half-written home', async () => {
        const id = 'bootrecoverHHHHHHHHHHHHHHHHHHHHH';
        seedFolder(id, 'half-written, no copy');
        seedRestoringMarker('boot-job-f', id, null);

        await recoverBackupsAfterRestart();

        expect(existsSync(join(homeRoot, id))).toBe(false);
        const parked = readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`));
        expect(parked.length).toBe(1);
        expect(readFileSync(join(homeRoot, parked[0], 'marker'), 'utf8')).toBe('half-written, no copy');
        made.push(join(homeRoot, parked[0]));
    });

    test('a folder whose restore finished has no marker, and the boot only removes it', async () => {
        const id = 'bootrecoverGGGGGGGGGGGGGGGGGGGGG';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260303-000000`;
        seedFolder(id, 'the restored home');
        seedFolder(aside, 'the home as it was');
        const staged = seedRestoringMarker('boot-job-e', id, aside);
        dropRestoringMarker(staged);

        await recoverBackupsAfterRestart();

        // The home in place is the restored one, and the copy beside it is the safety copy the admin decides about.
        expect(existsSync(staged)).toBe(false);
        expect(readFileSync(join(homeRoot, id, 'marker'), 'utf8')).toBe('the restored home');
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
        expect(readdirSync(homeRoot).filter((name) => name.startsWith(`${id}${FAILED_RESTORE_SUFFIX}`))).toEqual([]);
    });

    // A note torn in its write says nothing: the folders stay where they are, for a rename by hand.
    test('a marker that does not parse moves nothing', async () => {
        const id = 'bootrecoverTTTTTTTTTTTTTTTTTTTTT';
        const aside = `${id}${PRE_RESTORE_SUFFIX}20260404-000000`;
        seedFolder(aside, 'the home as it was');
        const staged = seedRestoringMarker('boot-job-torn', id, aside);
        writeFileSync(join(staged, 'restoring.json'), '{"ownerId": "boot');

        await recoverBackupsAfterRestart();

        expect(existsSync(staged)).toBe(false);
        expect(existsSync(join(homeRoot, id))).toBe(false);
        expect(readFileSync(join(homeRoot, aside, 'marker'), 'utf8')).toBe('the home as it was');
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
            counts: { databases: 0, files: 0, bytes: 0 },
            level: 'full',
            mounts: [],
            entries: [],
        };
        const artifact = freeArtifactName(archived, new Date('2026-01-01T00:00:00Z'));
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

        await recoverBackupsAfterRestart();

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
