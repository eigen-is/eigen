// What a restart does about the backup work the last process left behind, before the API listens. A per-home restore
// killed before its install was done leaves a note beside the home that says how to undo it; a home it cannot put back
// stays shut until a later boot does. The staging folder in backups/ is wiped, and a server backup left running is
// marked failed. A restore writes and removes its note, and undoes a failed install, through here. This module loads
// the API's jobs and settings, so ./eigen restore's stage must not import it.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getDataRoot, homeDirUnder, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../config/paths';
import { markHomeRestoring } from '../home/get-home';
import { describeError } from './errors';
import { buildRestoreStagingDir, isRestoreStagingName, wipeBackupStaging } from './paths';
import { recoverInterruptedServerBackups } from './server-archives';

// The note a restore leaves in the folder it staged, while its install is not done. Written before the move-aside and
// removed the moment the install is done, so a boot that finds one has a restore to undo.
const RESTORING_MARKER = 'restoring.json';
// `preRestoreName` is null for a deleted user, whose restore still needs the note: an unfinished install is not a
// home. `parkName` is the name that unfinished folder goes aside under.
type RestoringMarker = { ownerId: string; preRestoreName: string | null; parkName: string };

// Before the server listens, so no request opens a half-written home folder mid-recovery. A step that throws is logged
// and leaves the rest to the next boot: scratch space is no reason to keep the API down.
export async function recoverBackupsAfterRestart(): Promise<void> {
    try {
        recoverInterruptedRestores();
        wipeBackupStaging();
        await recoverInterruptedServerBackups();
    } catch (error) {
        console.error('[backup] the recovery stopped, the next boot tries again:', error);
    }
}

// The note goes in the folder the restore staged beside the home, on the home's own disk, so a boot that finds the
// home finds it too. A safety-copy restore unpacks nothing, so its folder is made here.
export function writeRestoringMarker(restoreDir: string, marker: RestoringMarker): void {
    fs.mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(restoreDir, RESTORING_MARKER), JSON.stringify(marker));
}

export function dropRestoringMarker(restoreDir: string): void {
    fs.rmSync(path.join(restoreDir, RESTORING_MARKER), { force: true });
}

// Everything a per-home restore staged beside the home: the unpacked archive and any note left. The job removes it
// however it ends. The note goes first: if the folder stays, a later boot acting on it could park a home made since.
export async function wipeRestoreStagingDir(homeDir: string, jobId: string): Promise<void> {
    const restoreDir = buildRestoreStagingDir(homeDir, jobId);
    dropRestoringMarker(restoreDir);
    await fsp.rm(restoreDir, { recursive: true, force: true });
}

// Every folder a per-home restore staged beside the homes is one whose job never ended, since a job removes its own.
// Its note is acted on first, and then it goes, because nothing resumes the job.
function recoverInterruptedRestores(): void {
    for (const kind of [USER_HOMES_DIR, TEAM_HOMES_DIR]) {
        const homesDir = path.join(getDataRoot(), kind);
        if (!fs.existsSync(homesDir)) continue;
        for (const name of fs.readdirSync(homesDir)) {
            if (!isRestoreStagingName(name)) continue;
            const restoreDir = path.join(homesDir, name);
            if (!recoverRestore(restoreDir, homesDir)) continue;
            // A throw here would leave the other homes' notes unread. The note goes first: acting on it again could
            // park a home made since.
            try {
                dropRestoringMarker(restoreDir);
                fs.rmSync(restoreDir, { recursive: true, force: true });
            } catch (error) {
                console.error(
                    `[backup] could not remove ${restoreDir}, the next boot tries again: ${describeError(error)}`,
                );
            }
        }
    }
}

// Returns false when a move failed. The note stays for the next boot, the home stays shut until then, and the other
// homes still recover.
function recoverRestore(restoreDir: string, homesDir: string): boolean {
    const marker = readRestoringMarker(path.join(restoreDir, RESTORING_MARKER));
    if (!marker) return true;
    const homeDir = homeDirUnder(path.dirname(homesDir), marker.ownerId);
    try {
        putHomeBack(marker, homeDir);
        return true;
    } catch (error) {
        keepHomeShut(marker.ownerId);
        // A restart cannot park the folder in place under a name that is taken, so only the operator can clear it.
        const parked = path.join(path.dirname(homeDir), marker.parkName);
        const advice =
            fs.existsSync(homeDir) && fs.existsSync(parked)
                ? `${parked} is already there, so move the folder at ${homeDir} aside by hand, then run ./eigen stop, then ./eigen restart`
                : 'run ./eigen stop, then ./eigen restart';
        console.error(
            `[backup] could not finish the interrupted restore of ${marker.ownerId}'s home ${homeDir}: ${describeError(error)}. The account answers 503, and its note stays in ${restoreDir} for the next boot: ${advice}`,
        );
        return false;
    }
}

// The mark a restore holds while it moves the home. It throws on a home marked already, such as by another of its
// notes, and a throw here would leave the other homes' notes unread.
function keepHomeShut(ownerId: string): void {
    try {
        markHomeRestoring(ownerId);
    } catch {
        // The home is shut already, by a restore's mark or a deletion's.
    }
}

// The moves that undo an unfinished install of the home at `homeDir`, as its marker describes it. Each looks at the
// disk first, so a run that failed partway, such as the job's own, is finished by the next boot's.
export function putHomeBack(marker: RestoringMarker, homeDir: string): void {
    const aside = marker.preRestoreName && path.join(path.dirname(homeDir), marker.preRestoreName);
    // The folder in place is the home: it never went aside, or a run before this put it back.
    if (aside && !fs.existsSync(aside)) return;
    // A folder in place is one the install had not finished with, so it is not trusted as a home. It is parked, not
    // deleted.
    if (fs.existsSync(homeDir)) {
        fs.renameSync(homeDir, path.join(path.dirname(homeDir), marker.parkName));
        console.error(
            `[backup] a restore of ${marker.ownerId} did not finish its install: the folder it was installing is ${marker.parkName}`,
        );
    }
    if (!aside) {
        console.error(`[backup] a restore of ${marker.ownerId} did not finish: they have no home folder again`);
        return;
    }
    fs.renameSync(aside, homeDir);
    console.error(
        `[backup] a restore of ${marker.ownerId} did not finish: ${marker.preRestoreName} is back in place as the home folder`,
    );
}

// Null for a restore that left none, or a note torn in its write, and then nothing says which folder is which.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    if (!fs.existsSync(markerPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}
