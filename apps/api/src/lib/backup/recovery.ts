// What a restart does about the backup work the last process left behind, before the API listens. A per-home restore
// killed before its job ended leaves notes beside the home that say whether to finish or undo it; a home they cannot
// put back stays shut until a later boot does. The staging folder in backups/ is wiped, and a server backup left
// running is marked failed. A restore writes and removes its notes, and undoes a failed install, through here. This
// module loads the API's jobs and settings, so ./eigen restore's stage must not import it.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_OWNER_ID } from '@workspace/lib/validation';
import { getDataRoot, homeDirUnder, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../config/paths';
import { markHomeRestoring } from '../home/get-home';
import { describeError } from './errors';
import { buildRestoreStagingDir, isRestoreStagingName, parseSafetyCopyName, wipeBackupStaging } from './paths';
import { recoverInterruptedServerBackups } from './server-archives';

// The note a restore leaves in the folder it staged, while the home folder is not where it belongs. Written before
// the move-aside, removed with the folder when the job ends, read once at the next boot.
const RESTORING_MARKER = 'restoring.json';
// Written beside it the moment the install is done, before the mark clears. A marker without this
// beside it means the process died with a home folder that is somewhere between the two states.
const RESTORE_COMPLETE_MARKER = 'restore-complete.json';
// `preRestoreName` is null for a deleted user, whose restore still needs the note: an unfinished install is not a
// home. `parkName` is the name that unfinished folder goes aside under.
type RestoringMarker = { ownerId: string; homeDir: string; preRestoreName: string | null; parkName: string };

// Before the server listens: a request that resolved a home while the recovery was still deciding about it would
// open a half-written folder as if it were the home. Then the staging folder in backups/ is cleared, because a backup
// or verify cut off by a restart leaves a half-written folder that nothing resumes. Last, a server backup killed
// mid-run left its record running, and it becomes a failed attempt.
export async function recoverBackupsAfterRestart(): Promise<void> {
    recoverInterruptedRestores();
    wipeBackupStaging();
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
            if (!recoverRestore(restoreDir, homesDir)) continue;
            // A throw here would stop every boot. The folder is acted on again by the next one, which changes nothing.
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

// Returns false when a move failed: a throw would stop every boot, so the notes stay for the next one and the home
// stays shut until then.
function recoverRestore(restoreDir: string, homesDir: string): boolean {
    const marker = readRestoringMarker(path.join(restoreDir, RESTORING_MARKER));
    const homeDir = marker && homeBesideNotes(homesDir, marker);
    if (!marker || !homeDir || !namesCopiesOf(marker, path.basename(homeDir))) return true;
    // The install finished. Whatever the job did after that cannot leave the home folder out of place.
    if (isRestoreComplete(path.join(restoreDir, RESTORE_COMPLETE_MARKER))) return true;
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
            `[backup] could not finish the interrupted restore of ${marker.ownerId}'s home ${homeDir}: ${describeError(error)}. The account answers 503, and its notes stay in ${restoreDir} for the next boot: ${advice}`,
        );
        return false;
    }
}

// The notes' own path need only end in the same home and homes folder, so a data folder moved since still recovers.
function homeBesideNotes(homesDir: string, marker: RestoringMarker): string | null {
    const homeDir = homeDirUnder(path.dirname(homesDir), marker.ownerId);
    if (path.dirname(homeDir) !== homesDir) return null;
    const sameName = path.basename(marker.homeDir) === path.basename(homeDir);
    const sameKind = path.basename(path.dirname(marker.homeDir)) === path.basename(homesDir);
    return sameName && sameKind ? homeDir : null;
}

// The marker goes before the rest of its folder. A kill partway through removing the folder could otherwise leave it
// without the completion note beside it, and a later boot would undo a restore whose home has served since.
function dropRestoringMarker(restoreDir: string): void {
    fs.rmSync(path.join(restoreDir, RESTORING_MARKER), { force: true });
}

// The mark a restore holds while it moves the home. It throws on a home marked already, such as by another of its
// notes, and a throw here would stop the server from starting.
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

// The marker survived a crash and names folders this then renames, so it is read as untrusted input. Its owner must
// be one whose home a restore replaces, a user or a team. Which home folder that is, its caller decides.
function readRestoringMarker(markerPath: string): RestoringMarker | null {
    const value = readNote(markerPath);
    if (typeof value !== 'object' || value === null) return null;
    if (!('ownerId' in value) || !('homeDir' in value) || !('preRestoreName' in value) || !('parkName' in value)) {
        return null;
    }
    const { ownerId, homeDir, preRestoreName, parkName } = value;
    if (typeof ownerId !== 'string' || typeof homeDir !== 'string' || typeof parkName !== 'string') return null;
    if (preRestoreName !== null && typeof preRestoreName !== 'string') return null;
    const { type } = parseOwnerId(ownerId);
    if (!BACKUP_OWNER_ID.test(ownerId) || (type !== 'user' && type !== 'team')) return null;
    return { ownerId, homeDir, preRestoreName, parkName };
}

// Both names the marker gives have to be safety copies of exactly the home folder it acts on, the one to put back a
// pre-restore copy.
function namesCopiesOf({ preRestoreName, parkName }: RestoringMarker, homeName: string): boolean {
    if (parseSafetyCopyName(parkName)?.homeName !== homeName) return false;
    if (preRestoreName === null) return true;
    const parsed = parseSafetyCopyName(preRestoreName);
    return parsed?.kind === 'pre-restore' && parsed.homeName === homeName;
}

// The completion note as writeRestoreCompleteMarker writes it. Anything else beside a marker says nothing.
function isRestoreComplete(notePath: string): boolean {
    const value = readNote(notePath);
    return (
        typeof value === 'object' && value !== null && 'completedAt' in value && typeof value.completedAt === 'string'
    );
}

// A note's JSON, or undefined for one that is not there or does not parse.
function readNote(notePath: string): unknown {
    if (!fs.existsSync(notePath)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(notePath, 'utf8'));
    } catch {
        return undefined;
    }
}
