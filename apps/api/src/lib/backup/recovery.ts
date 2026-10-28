// What a restart does about the backup work the last process left behind, in the order it must happen, before the
// API listens. A per-home restore that died halfway is finished or undone from the notes in its staging folder,
// then the staging folders are wiped, the home archives are closed to other users, and a server backup left running
// is marked failed. The restore writes those notes through here. This module loads the API's jobs and settings, so
// the stage of ./eigen restore must not import it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBackupArtifactName } from '@workspace/lib/validation';
import { ARCHIVE_MODE } from './archive';
import { describeError } from './errors';
import {
    backupsDirPath,
    getBackupStagingDir,
    getStagingRoot,
    parseSafetyCopyName,
    SIDECAR_SUFFIX,
    wipeBackupStaging,
} from './paths';
import { recoverInterruptedServerBackups } from './server-archives';

// The note a restore leaves in its staging folder while the home folder is not where it belongs.
// Written before the move-aside, removed when the mark clears, read once at the next boot.
const RESTORING_MARKER = 'restoring.json';
// Written beside it the moment the install is done, before the mark clears. A marker without this
// beside it means the process died with a home folder that is somewhere between the two states.
const RESTORE_COMPLETE_MARKER = 'restore-complete.json';
// `preRestoreName` is null when there was no home folder to move aside (a restore of a deleted
// user). The marker is still written: the folder the install is halfway through is not a home
// either, and nothing but this says so. `parkName` is what that folder goes aside as: a
// `.failed-restore-` name for an extraction, the copy's own name for a safety copy put back.
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string | null; parkName: string };

// Before the server listens: a request that resolved a home while the recovery was still deciding about it would
// open a half-written folder as if it were the home. A restore that died between moving the home aside and
// installing the archive left a note in its staging folder, so that is read first, before the wipe takes the
// staging folders with it. Then they are cleared, because a backup, verify or restore cut off by a restart leaves a
// half-written folder that nothing resumes. An older build left its home archives readable, and they are closed. Last,
// a server backup killed mid-run left its record running, and it becomes a failed attempt.
export async function recoverBackupsAfterRestart(): Promise<void> {
    recoverInterruptedRestores();
    wipeBackupStaging();
    closeHomeArchives();
    await recoverInterruptedServerBackups().catch((error) =>
        console.error('[backup] recovering server records:', error),
    );
}

export function writeRestoringMarker(jobId: string, marker: RestoringMarker): void {
    fs.writeFileSync(path.join(getBackupStagingDir(jobId), RESTORING_MARKER), JSON.stringify(marker));
}

export function writeRestoreCompleteMarker(jobId: string): void {
    fs.writeFileSync(
        path.join(getBackupStagingDir(jobId), RESTORE_COMPLETE_MARKER),
        JSON.stringify({ completedAt: new Date().toISOString() }),
    );
}

// A restore killed anywhere between the move-aside and the last install step left the home folder
// either gone or half written, with its real contents under the `{id}.pre-restore-{ts}` its marker
// names. The process that knew about it is dead, so nothing else will ever put it back. This does,
// and logs it as an error. The install writes a completion note beside the marker, which tells a
// restore that finished from one that did not. This runs before the staging wipe, which clears the
// markers of both. A safety copy with no marker is not evidence of anything: nothing deletes them
// automatically, so a deleted user leaves one behind.
export function recoverInterruptedRestores(): void {
    const stagingRoot = getStagingRoot();
    if (!fs.existsSync(stagingRoot)) return;
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const jobDir = path.join(stagingRoot, entry.name);
        const marker = readRestoringMarker(path.join(jobDir, RESTORING_MARKER));
        if (!marker) continue;
        // The install finished. Whatever the job did after that cannot leave the home folder out of place.
        if (fs.existsSync(path.join(jobDir, RESTORE_COMPLETE_MARKER))) continue;
        const aside = marker.preRestoreName && path.join(path.dirname(marker.homeDir), marker.preRestoreName);
        // A copy the restore's own rollback already put back is not there any more, and this must
        // not move the home folder that is in place over it.
        if (aside && !fs.existsSync(aside)) continue;
        // A folder that is there without the completion note is the one the install was writing: an
        // extraction whose mount materialization, checks or identity writes did not land, or a safety
        // copy renamed into place before its checks. It goes aside under the name the marker gives,
        // exactly as a failure the job itself caught would have left it. Nothing is deleted, whether or
        // not there is a copy to put back afterwards.
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
            continue;
        }
        fs.renameSync(aside, marker.homeDir);
        console.error(
            `[backup] a restore of ${marker.ownerId} was interrupted: ${marker.preRestoreName} is back in place as the home folder`,
        );
    }
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
