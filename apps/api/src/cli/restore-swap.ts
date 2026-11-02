// The swap of ./eigen restore, which runs as root with Eigen stopped and moves a staged archive into data/: the
// archive replaces data/ whole, and what it replaces is kept aside. The renames go into a marker on disk before the
// first one runs, so a swap cut off anywhere is finished by the next run. It also answers --staged, which the
// launcher asks before it stops Eigen.

import type { Database } from 'bun:sqlite';
import {
    chmodSync,
    closeSync,
    cpSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { buildBackupStamp } from '@workspace/lib/validation';
import { describeError } from '../lib/backup/errors';
import { buildSafetyCopyName, INSTALL_FOLDERS, nextFreeTime, STAGING_DIR } from '../lib/backup/paths';
import { RESTORING_DATA_DIR, RESTORING_DIR } from '../lib/backup/restore-server';
import { DATA_LEASE_FILE, DATA_LOCK_FILE, liveLeaseHolder, lockDataDir } from '../lib/config/data-lock';
import { SERVER_DIR } from '../lib/config/paths';
import { PIN_KEYS } from '../lib/config/release';
import { readEnvFile } from './env-file';
import { BACKUPS, DATA, ENV_PATH, installOwner, ownAs } from './install';
import type { Ui } from './ui';
import { createUi, glyphLine } from './ui';

// Written by the swap before its first rename, read by the launcher's preflight: while it is there, a swap was cut
// off, and --swap finishes it.
export const SWAP_MARKER = '.eigen/restore-swap';
// Held by a swap from before it reads the marker until it exits. It lives in .eigen/, as the swap moves data/.
export const SWAP_LOCK = '.eigen/restore.lock';
// Written last by the stage, so a stage cut off halfway is never swapped in.
export const STAGE_RECORD = 'staged.json';
export type StagedRestore = { archive: string; appVersion: string };

// The marker: the renames to run in order, each from and to, relative to the install folder. `aside` names what the
// operator finds kept aside after the swap.
type RestoreSwap = {
    archive: string;
    renames: [string, string][];
    aside: string[];
    leftover: string;
    env: boolean;
};

// What unsafeEntry() looks for. A setgid folder is fine: a setgid install folder hands that bit to every folder in it.
const UNSAFE_FIND_ARGS =
    '-type b -o -type c -o -type p -o -type s -o -type f ( -perm -4000 -o -perm -2000 ) -o -type l';

// Every lock this run takes stays open until the process exits, as the API holds the data lock while it runs.
const locks: Database[] = [];

export async function swap(): Promise<void> {
    const ui = await createUi(true);
    mkdirSync(dirname(SWAP_LOCK), { recursive: true });
    if (!holdLock(SWAP_LOCK)) {
        return ui.fail('Another restore is swapping data/.', 'Wait for it to finish, then run ./eigen restore again.');
    }
    if (existsSync(SWAP_MARKER)) {
        lockData(ui);
        const marked = readRecord(SWAP_MARKER, isRestoreSwap);
        if (!marked) {
            return ui.fail(
                `${SWAP_MARKER} does not read as a swap.`,
                `Put data/ right by hand, then delete ${SWAP_MARKER}.`,
            );
        }
        return runSwap(ui, marked);
    }
    const restoring = join(DATA, RESTORING_DIR);
    const record = readRecord(join(restoring, STAGE_RECORD), isStagedRestore);
    if (!record) {
        return ui.fail('Nothing is staged to swap in.', 'Run ./eigen restore <archive>, which stages it first.');
    }
    requireRenamable(ui, record.archive);
    lockData(ui);
    const reason = await unsafeEntry(restoring);
    if (reason) {
        return ui.fail(
            `The staged ${record.archive} cannot be swapped in: ${reason}.`,
            'Run ./eigen restore <archive> again.',
        );
    }
    const stagedData = join(restoring, RESTORING_DATA_DIR);

    const asideOf = (path: string, at: Date) => buildSafetyCopyName(path, 'pre-restore', buildBackupStamp(at));
    const at = nextFreeTime(
        new Date(),
        (candidate) => pathExists(asideOf(DATA, candidate)) || pathExists(asideOf(ENV_PATH, candidate)),
    );
    const [dataAside, envAside] = [asideOf(DATA, at), asideOf(ENV_PATH, at)];
    const stagedEnv = join(restoring, ENV_PATH);
    const env = existsSync(stagedEnv);
    const renames: [string, string][] = [];
    if (env && pathExists(ENV_PATH)) renames.push([ENV_PATH, envAside]);
    if (env) renames.push([stagedEnv, ENV_PATH]);
    // An archive without the DKIM key or the TLS certificate keeps the one here: mail would sign with a key DNS does
    // not publish, and serve IMAP and SMTP with a self-signed certificate.
    for (const { dir: top } of INSTALL_FOLDERS) {
        if (!existsSync(join(stagedData, top)) && existsSync(join(DATA, top))) {
            cpSync(join(DATA, top), join(stagedData, top), { recursive: true });
        }
    }
    renames.push([DATA, dataAside], [join(dataAside, RESTORING_DIR, RESTORING_DATA_DIR), DATA]);
    const marker: RestoreSwap = {
        archive: record.archive,
        renames,
        aside: [dataAside, envAside],
        leftover: join(dataAside, RESTORING_DIR),
        env,
    };
    writeMarker(marker);
    runSwap(ui, marker);
}

// Run by the launcher before it stops Eigen, so a swap that cannot rename is refused while Eigen still runs.
export async function printStaged(): Promise<void> {
    const restoring = join(DATA, RESTORING_DIR);
    const record = readRecord(join(restoring, STAGE_RECORD), isStagedRestore);
    if (!record) {
        console.error(glyphLine('bad', 'Nothing is staged.'));
        process.exit(1);
    }
    requireRenamable(await createUi(true), record.archive);
    const env = readEnvFile(join(restoring, ENV_PATH));
    const pins = PIN_KEYS.flatMap((key) => (env.has(key) ? [`${key}=${env.get(key)}`] : []));
    console.log([`version=${record.appVersion}`, ...pins].join('\n'));
}

// Takes the lock in `file` until the process exits, or returns false when another process holds it.
export function holdLock(file: string): boolean {
    const lock = lockDataDir(file);
    if (lock) locks.push(lock);
    return lock !== null;
}

// The swap is renames: a linked data/ would move the link, and one on another disk cannot be renamed, and neither can
// a staged tree on another disk than data/.
function requireRenamable(ui: Ui, archive: string): void {
    const data = lstatSync(DATA);
    if (data.isSymbolicLink() || data.dev !== statSync('.').dev) {
        ui.fail(
            'Restore needs data/ as a folder inside the install folder.',
            'Move the data into data/ here, then run ./eigen restore again.',
        );
    }
    const stagedData = join(DATA, RESTORING_DIR, RESTORING_DATA_DIR);
    const tree = lstatSync(stagedData, { throwIfNoEntry: false });
    if (tree && tree.dev !== data.dev) {
        ui.fail(
            `${archive} cannot be swapped in: ${stagedData} is on another disk than ${DATA}.`,
            `Restore needs data/${RESTORING_DIR} on the disk of data/: unmount what is there, then run ./eigen restore again.`,
        );
    }
}

// Neither Eigen nor another swap reads or replaces data/ while this one does. The lock only refuses an API it reaches.
// An API it does not reach, such as one on the host beside the container, is refused by its lease, which the swap
// only reads.
function lockData(ui: Ui): void {
    const lockFile = join(DATA, SERVER_DIR, DATA_LOCK_FILE);
    // Root must not create a lock file the API could not open. Without one, no API ever ran on this data/.
    if (existsSync(lockFile) && !holdLock(lockFile)) {
        ui.fail(
            'data/ is in use by Eigen or by another restore.',
            'Wait for it to finish, then run ./eigen restore again.',
        );
    }
    const holder = liveLeaseHolder(join(DATA, SERVER_DIR, DATA_LEASE_FILE), (message) => ui.warn(message, []));
    if (holder) ui.fail(`data/ is in use by another Eigen API: ${holder}.`, 'Stop it, then run ./eigen restore again.');
}

// Why root must not swap the staged tree in, or null. It drops the fifos and sockets. The stage writes files and
// folders only, so anything else came from somebody else.
async function unsafeEntry(restoring: string): Promise<string | null> {
    const env = lstatSync(join(restoring, ENV_PATH), { throwIfNoEntry: false });
    if (env && (!env.isFile() || env.nlink > 1)) return `${ENV_PATH} is not a plain file`;
    if (!lstatSync(join(restoring, RESTORING_DATA_DIR), { throwIfNoEntry: false })?.isDirectory()) {
        return 'data is not a folder';
    }
    const suspects = Bun.spawn(['find', restoring, '(', ...UNSAFE_FIND_ARGS.split(' '), ')', '-print0'], {
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const [listed, code] = await Promise.all([new Response(suspects.stdout).text(), suspects.exited]);
    if (code !== 0) return 'its files cannot be listed';
    for (const path of listed.split('\0').filter(Boolean)) {
        const stat = lstatSync(path);
        const name = relative(restoring, path);
        if (stat.isSymbolicLink()) return `${name} is a link`;
        if (stat.isFile()) return `${name} is setuid or setgid`;
        if (stat.isFIFO() || stat.isSocket()) rmSync(path);
        else return `${name} is a device`;
    }
    return null;
}

function pathExists(path: string): boolean {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

// Durable before the first rename: a marker lost to a power cut would leave a half-swapped data/ nobody knows of.
function writeMarker(marker: RestoreSwap): void {
    const temporary = `${SWAP_MARKER}.tmp`;
    const file = openSync(temporary, 'w', 0o600);
    try {
        writeSync(file, JSON.stringify(marker, null, 2));
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    renameSync(temporary, SWAP_MARKER);
    const dir = openSync(dirname(SWAP_MARKER), 'r');
    try {
        fsyncSync(dir);
    } finally {
        closeSync(dir);
    }
}

// Renames that already happened are skipped, so a swap cut off anywhere finishes where it stopped. A path both moved
// away and moved back into counts as moved when the later rename is done.
function runSwap(ui: Ui, swap: RestoreSwap): void {
    const cannot = (detail: string): never =>
        ui.fail(
            `The swap of ${swap.archive} stopped halfway and cannot go on: ${detail}.`,
            `${SWAP_MARKER} lists every rename; what went aside is in ${swap.aside.join(', ')}. Put data/ right by hand, then delete ${SWAP_MARKER}.`,
        );
    for (const [index, [from, to]] of swap.renames.entries()) {
        const [fromHere, toHere] = [pathExists(from), pathExists(to)];
        if (!fromHere && toHere) continue;
        if (fromHere && toHere) {
            const refilled = swap.renames.slice(index + 1).some(([later, onto]) => onto === from && !pathExists(later));
            if (refilled) continue;
            cannot(`${from} and ${to} are both there`);
        }
        if (!fromHere) cannot(`${from} is gone`);
        try {
            renameSync(from, to);
        } catch (error) {
            ui.fail(
                `The swap of ${swap.archive} stopped at ${from}: ${describeError(error)}.`,
                'Fix what it says, then run ./eigen restart, which finishes the swap first.',
            );
        }
    }
    if (swap.env) {
        ownAs(ENV_PATH, installOwner('.'));
        chmodSync(ENV_PATH, 0o600);
    }
    rmSync(swap.leftover, { recursive: true, force: true });
    // A per-home restore's notes in there name homes of the data/ that went aside: the boot must not act on them.
    rmSync(join(BACKUPS, STAGING_DIR), { recursive: true, force: true });
    rmSync(SWAP_MARKER);
    // An aside that keeps nothing goes: a new machine's empty data/, and the .env.production the archive's replaced
    // there. Only once the marker is gone: a rerun would find the restored ones with no aside and move them again.
    const [dataAside = '', envAside = ''] = swap.aside;
    if (lstatSync(dataAside, { throwIfNoEntry: false })?.isDirectory() && readdirSync(dataAside).length === 0) {
        rmSync(dataAside, { recursive: true });
    }
    if (existsSync(envAside) && readFileSync(envAside).equals(readFileSync(ENV_PATH))) rmSync(envAside);
    console.log(glyphLine('ok', `Swapped in ${swap.archive}`));
    const aside = swap.aside.filter((path) => existsSync(path));
    // 'Kept aside: ' is grepped by finish_swap in eigen.
    if (aside.length) console.log(glyphLine('ok', `Kept aside: ${aside.join(', ')}`));
    console.log(glyphLine('ok', 'Everyone is signed in as they were when the archive was made'));
}

// Records this CLI wrote. A stage cut off mid-write leaves a torn staged.json, which is nothing staged; the marker is
// written whole or not at all, and one that does not read stops the swap. One of another shape reads as neither.
function readRecord<T>(file: string, is: (value: unknown) => value is T): T | null {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    return is(value) ? value : null;
}

function isStagedRestore(value: unknown): value is StagedRestore {
    return (
        typeof value === 'object' &&
        value !== null &&
        'archive' in value &&
        typeof value.archive === 'string' &&
        'appVersion' in value &&
        typeof value.appVersion === 'string'
    );
}

function isPaths(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((path) => typeof path === 'string');
}

function isMoves(value: unknown): value is [string, string][] {
    return Array.isArray(value) && value.every((move) => isPaths(move) && move.length === 2);
}

function isRestoreSwap(value: unknown): value is RestoreSwap {
    return (
        typeof value === 'object' &&
        value !== null &&
        'archive' in value &&
        typeof value.archive === 'string' &&
        'renames' in value &&
        isMoves(value.renames) &&
        'aside' in value &&
        isPaths(value.aside) &&
        'leftover' in value &&
        typeof value.leftover === 'string' &&
        'env' in value &&
        typeof value.env === 'boolean'
    );
}
