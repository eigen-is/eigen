// What a restart does about the backup work the last process left behind, before the API listens. A per-home restore
// killed before its job ended leaves the folder it staged beside the home, whose notes say whether to finish or undo
// it, and then the folder goes. The staging folders in backups/ are wiped, the home archives closed to other users,
// and a server backup left running is marked failed. The restore writes and removes its notes through here. This
// module loads the API's jobs and settings, so the stage of ./eigen restore must not import it.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseBackupArtifactName } from '@workspace/lib/validation';
import { getDataRoot, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../config/paths';
import { ARCHIVE_MODE } from './archive';
import { describeError } from './errors';
import {
    backupsDirPath,
    buildRestoreStagingDir,
    getStagingRoot,
    isRestoreStagingName,
    parseSafetyCopyName,
    SIDECAR_SUFFIX,
    wipeBackupStaging,
} from './paths';
import { recoverInterruptedServerBackups } from './server-archives';

// The note a restore leaves in the folder it staged, while the home folder is not where it belongs. Written before
// the move-aside, removed with the folder when the job ends, read once at the next boot.
const RESTORING_MARKER = 'restoring.json';
// Written beside it the moment the install is done, before the mark clears. A marker without this
// beside it means the process died with a home folder that is somewhere between the two states.
const RESTORE_COMPLETE_MARKER = 'restore-complete.json';
// `preRestoreName` is null when there was no home folder to move aside (a restore of a deleted
// user). The marker is still written: the folder the install puts in place is not a home until
// it is done, and nothing but this says so. `parkName` is what that folder goes aside as: a
// `.failed-restore-` name for a home from an archive, the copy's own name for a safety copy put back.
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string | null; parkName: string };

// Before the server listens: a request that resolved a home while the recovery was still deciding about it would
// open a half-written folder as if it were the home. Then the staging folders in backups/ are cleared, because a
// backup or verify cut off by a restart leaves a half-written folder that nothing resumes. An older build left its
// home archives readable, and they are closed. Last, a server backup killed mid-run left its record running, and it
// becomes a failed attempt.
export async function recoverBackupsAfterRestart(): Promise<void> {
    recoverInterruptedRestores();
    recoverOlderBuildRestores();
    wipeBackupStaging();
    closeHomeArchives();
    await recoverInterruptedServerBackups().catch((error) =>
        console.error('[backup] recovering server records:', error),
    );
}

// The notes go in the folder the restore staged beside the home, on the home's own disk, so a boot that finds the
// home finds them too. A safety-copy restore unpacks nothing, so its folder is made here.
export function writeRestoringMarker(restoreDir: string, marker: RestoringMarker): void {
    fs.mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(restoreDir, RESTORING_MARKER), JSON.stringify(marker));
}

export function writeRestoreCompleteMarker(restoreDir: string): void {
    fs.writeFileSync(
        path.join(restoreDir, RESTORE_COMPLETE_MARKER),
        JSON.stringify({ completedAt: new Date().toISOString() }),
    );
}

// Everything a per-home restore staged beside the home: the unpacked archive and the notes the next boot reads. The
// job removes it however it ends.
export async function wipeRestoreStagingDir(homeDir: string, jobId: string): Promise<void> {
    const restoreDir = buildRestoreStagingDir(homeDir, jobId);
    dropRestoringMarker(restoreDir);
    await fsp.rm(restoreDir, { recursive: true, force: true });
}

// Every folder a per-home restore staged beside the homes is one whose job never ended, since a job removes its own.
// Its notes are acted on first, and then it goes, because nothing resumes the job.
export function recoverInterruptedRestores(): void {
    for (const kind of [USER_HOMES_DIR, TEAM_HOMES_DIR]) {
        const homesDir = path.join(getDataRoot(), kind);
        if (!fs.existsSync(homesDir)) continue;
        for (const name of fs.readdirSync(homesDir)) {
            if (!isRestoreStagingName(name)) continue;
            const restoreDir = path.join(homesDir, name);
            recoverRestore(restoreDir);
            dropRestoringMarker(restoreDir);
            fs.rmSync(restoreDir, { recursive: true, force: true });
        }
    }
}

// The marker goes before the rest of its folder. A kill partway through removing the folder could otherwise leave it
// without the completion note beside it, and a later boot would undo a restore whose home has served since.
function dropRestoringMarker(restoreDir: string): void {
    fs.rmSync(path.join(restoreDir, RESTORING_MARKER), { force: true });
}

// Builds up to 0.4.1 kept the notes in backups/.staging. That is another mount than the homes on Docker, so a boot
// that ran without the backups folder could leave them to a later boot, which acted on them stale. They are still
// read, so an upgrade right after a killed restore recovers it. Drop this in the release after the one that ships
// the notes beside the home: by then no install holds an old note.
function recoverOlderBuildRestores(): void {
    const stagingRoot = getStagingRoot();
    if (!fs.existsSync(stagingRoot)) return;
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const notesDir = path.join(stagingRoot, entry.name);
        recoverRestore(notesDir);
        dropRestoringMarker(notesDir);
    }
}

// A restore killed anywhere between the move-aside and the last install step left the home's path
// empty or holding a folder it had not finished with, and the home's real contents under the
// `{id}.pre-restore-{ts}` its marker names. The process that knew about it is dead, so nothing else
// will ever put it back. This does, and logs it as an error. A completion note beside the marker
// tells a restore that finished from one that did not. A safety copy with no marker is not evidence
// of anything: nothing deletes them automatically, so a deleted user leaves one behind.
function recoverRestore(notesDir: string): void {
    const marker = readRestoringMarker(path.join(notesDir, RESTORING_MARKER));
    if (!marker) return;
    // The install finished. Whatever the job did after that cannot leave the home folder out of place.
    if (fs.existsSync(path.join(notesDir, RESTORE_COMPLETE_MARKER))) return;
    const aside = marker.preRestoreName && path.join(path.dirname(marker.homeDir), marker.preRestoreName);
    // The home never went aside, or the restore's own rollback already put it back. Either way the folder in place
    // is the home, and this must not move it.
    if (aside && !fs.existsSync(aside)) return;
    // A folder that is there without the completion note is the one the install put in place:
    // a home from an archive moved in just before the kill, or a safety copy renamed into place
    // before its trash was re-dated. It goes aside under the name the marker gives, exactly as a
    // failure the job itself caught would have left it. Nothing is deleted, whether or not there
    // is a copy to put back afterwards.
    if (fs.existsSync(marker.homeDir)) {
        fs.renameSync(marker.homeDir, path.join(path.dirname(marker.homeDir), marker.parkName));
        console.error(
            `[backup] a restore of ${marker.ownerId} was interrupted mid-install: the folder it was installing is ${marker.parkName}`,
        );
    }
    if (!aside) {
        // A restore of a deleted user: there was no home to move aside, so the only thing to do
        // is refuse to leave the half-written folder standing as one.
        console.error(`[backup] a restore of ${marker.ownerId} was interrupted: they have no home folder again`);
        return;
    }
    fs.renameSync(aside, marker.homeDir);
    console.error(
        `[backup] a restore of ${marker.ownerId} was interrupted: ${marker.preRestoreName} is back in place as the home folder`,
    );
}

// A build before 0.4.1 wrote a home archive and its sidecar with the umask's mode, so other users of the host read
// password hashes and keys out of them. Both get the mode every archive is written with now. A server archive's
// sidecar keeps its mode, because ./eigen reads it as the operator. A file the API's user does not own, such as one an
// operator copied in as root, is named and left as it is, since the server must still start.
function closeHomeArchives(): void {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        const archiveName = name.endsWith(SIDECAR_SUFFIX) ? name.slice(0, -SIDECAR_SUFFIX.length) : name;
        if (!parseBackupArtifactName(archiveName)) continue;
        const file = path.join(dir, name);
        try {
            // A chmod follows a symlink to wherever it points, so only a regular file is closed.
            if (fs.lstatSync(file).isFile()) fs.chmodSync(file, ARCHIVE_MODE);
        } catch (error) {
            console.error(`[backup] could not close ${name} to other users: ${describeError(error)}`);
        }
    }
}

// The marker survived a crash and names two paths this then renames, so it is read as untrusted
// input: both names have to be safety copies of exactly the home folder it claims, the one to put back a
// pre-restore copy.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    if (!fs.existsSync(markerPath)) return null;
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    if (!('ownerId' in value) || !('homeDir' in value) || !('preRestoreName' in value) || !('parkName' in value)) {
        return null;
    }
    const { ownerId, homeDir, preRestoreName, parkName } = value;
    if (typeof ownerId !== 'string' || typeof homeDir !== 'string' || typeof parkName !== 'string') return null;
    if (preRestoreName !== null && typeof preRestoreName !== 'string') return null;
    if (parseSafetyCopyName(parkName)?.homeName !== path.basename(homeDir)) return null;
    if (preRestoreName !== null) {
        const parsed = parseSafetyCopyName(preRestoreName);
        if (parsed?.kind !== 'pre-restore' || parsed.homeName !== path.basename(homeDir)) return null;
    }
    return { ownerId, homeDir, preRestoreName, parkName };
}
