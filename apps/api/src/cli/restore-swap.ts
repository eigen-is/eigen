// The swap of ./eigen restore, which runs as root with Eigen stopped and moves a staged archive into data/. It plans
// every copy and rename first: a Full archive replaces data/ whole, and a Light one merges into the homes here. The
// plan goes into a marker on disk before the first rename, so a swap cut off anywhere is finished by the next run.
// What the swap replaces is kept aside. It also answers --staged, which the launcher asks before it stops Eigen.

import type { Database } from 'bun:sqlite';
import {
    chmodSync,
    closeSync,
    copyFileSync,
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
import type { BackupLevel } from '@workspace/lib/types/backup';
import { BACKUP_LEVELS } from '@workspace/lib/types/backup';
import { buildBackupStamp } from '@workspace/lib/validation';
import { isLightSkipped } from '../lib/backup/archive-layout';
import { describeError } from '../lib/backup/errors';
import { buildSafetyCopyName, INSTALL_FOLDERS, nextFreeTime, STAGING_DIR } from '../lib/backup/paths';
import { RESTORING_DATA_DIR, RESTORING_DIR } from '../lib/backup/restore-server';
import { DATA_LEASE_FILE, DATA_LOCK_FILE, liveLeaseHolder, lockDataDir } from '../lib/config/data-lock';
import { ORG_HOMES_DIR, PATHS, SERVER_DIR, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../lib/config/paths';
import { PIN_KEYS } from '../lib/config/release';
import { readEnvFile } from './env-file';
import type { Owner } from './install';
import { BACKUPS, DATA, ENV_PATH, installOwner, ownAs } from './install';
import type { Ui } from './ui';
import { createUi, glyphLine } from './ui';

// Written by the swap before its first rename, read by the launcher's preflight: while it is there, a swap was cut
// off, and --swap finishes it.
export const SWAP_MARKER = '.eigen/restore-swap';
// Held by a swap from before it reads the marker until it exits. It lives in .eigen/, as a Full swap moves data/.
export const SWAP_LOCK = '.eigen/restore.lock';
// Written last by the stage, so a stage cut off halfway is never swapped in. `orphans` are the home folders here that
// no account in the archive owns, relative to data/, which a Light swap sets aside.
export const STAGE_RECORD = 'staged.json';
export type StagedRestore = { archive: string; level: BackupLevel; appVersion: string; orphans: string[] };

// The marker: the copies to make, then the renames to run in order, each from and to, relative to the install
// folder. `aside` names what the operator finds kept aside after the swap.
type RestoreSwap = {
    archive: string;
    copies: [string, string][];
    renames: [string, string][];
    aside: string[];
    leftover: string;
    env: boolean;
};

type LightEntry = { path: string; dir: boolean };

// What an orphan in staged.json may name: one user's or team's folder, never a hidden one such as a restore's own.
const ORPHAN_HOME = new RegExp(`^(${USER_HOMES_DIR}|${TEAM_HOMES_DIR})/[^/.][^/]*$`);

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
    const copies: [string, string][] = [];
    const renames: [string, string][] = [];
    if (env && pathExists(ENV_PATH)) renames.push([ENV_PATH, envAside]);
    if (env) renames.push([stagedEnv, ENV_PATH]);
    let leftover = restoring;
    if (record.level === 'light') {
        const plan = planLight(stagedData, dataAside, record.orphans);
        if ('conflict' in plan) {
            return ui.fail(
                `${record.archive} cannot be swapped in: ${plan.conflict}.`,
                'Move it out of the way, then run ./eigen restore again.',
            );
        }
        renames.push(...plan.renames);
        // The pending uploads stay for the restored rows that name them. The next start sweeps the rest, so a copy
        // of each goes aside.
        const uploads = new Bun.Glob(`${PATHS.DRIVE.ROOT}/*/${PATHS.DRIVE.STAGING_DIR}/*`);
        for (const home of plan.merged) {
            for (const path of uploads.scanSync({ cwd: join(DATA, home), dot: true })) {
                copies.push([join(DATA, home, path), join(dataAside, home, path)]);
            }
        }
    } else {
        // An archive without the DKIM key or the TLS certificate keeps the one here: mail would sign with a key DNS
        // does not publish, and serve IMAP and SMTP with a self-signed certificate.
        for (const { dir: top } of INSTALL_FOLDERS) {
            if (!existsSync(join(stagedData, top)) && existsSync(join(DATA, top))) {
                cpSync(join(DATA, top), join(stagedData, top), { recursive: true });
            }
        }
        renames.push([DATA, dataAside], [join(dataAside, RESTORING_DIR, RESTORING_DATA_DIR), DATA]);
        leftover = join(dataAside, RESTORING_DIR);
    }

    // A home bind-mounted from another disk cannot be renamed into or out of.
    for (const [from, to] of renames) {
        if (pathExists(from) && lstatSync(from).dev !== deviceOf(dirname(to))) {
            return ui.fail(
                `${record.archive} cannot be swapped in: ${from} is on another disk than ${dirname(to)}.`,
                'Restore needs data/ and every home in it on the disk of the install folder.',
            );
        }
    }
    // Made before the marker and owned like what moves in. A swap cut off before the marker plans them again, and
    // finds them there.
    for (const [from, to] of renames) if (to.startsWith(`${DATA}/`)) makeParents(to, lstatSync(from));

    const marker: RestoreSwap = {
        archive: record.archive,
        copies,
        renames,
        aside: [dataAside, envAside],
        leftover,
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
    console.log([`version=${record.appVersion}`, `level=${record.level}`, ...pins].join('\n'));
}

// Takes the lock in `file` until the process exits, or returns false when another process holds it.
export function holdLock(file: string): boolean {
    const lock = lockDataDir(file);
    if (lock) locks.push(lock);
    return lock !== null;
}

// The swap is renames: a linked data/ would move the link, and one on another disk cannot be renamed. The check of
// each rename in swap() misses a Full swap's second: its source is only there once data/ moved aside.
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

// Light: server/, org/, dkim/ and certs/ go aside whole, and the staged ones move in. In a home here, every file a
// Light archive would hold goes aside first, whether this archive holds it or not, because a -wal left beside another
// database would be replayed onto it. A folder only here stays. A folder or a home only in the archive moves in
// whole. A home here that no account in the archive owns, such as that of a user made since, goes aside whole:
// nobody would sign in to it. `merged` are the homes here the archive merges into, relative to data/.
function planLight(
    staged: string,
    aside: string,
    orphans: readonly string[],
): { renames: [string, string][]; merged: string[] } | { conflict: string } {
    const renames: [string, string][] = [];
    const merged: string[] = [];
    for (const top of [SERVER_DIR, ORG_HOMES_DIR, ...INSTALL_FOLDERS.map((folder) => folder.dir)]) {
        if (!existsSync(join(staged, top))) continue;
        if (pathExists(join(DATA, top))) renames.push([join(DATA, top), join(aside, top)]);
        renames.push([join(staged, top), join(DATA, top)]);
    }
    // Named at the stage, by the API's user, who can write staged.json: root moves only a home folder that is here and
    // that the archive does not hold. A home deleted since is gone already.
    const homesHere = new Set(
        [USER_HOMES_DIR, TEAM_HOMES_DIR].flatMap((kind) =>
            existsSync(join(DATA, kind)) ? readdirSync(join(DATA, kind)).map((id) => `${kind}/${id}`) : [],
        ),
    );
    for (const orphan of orphans) {
        if (ORPHAN_HOME.test(orphan) && homesHere.has(orphan) && !pathExists(join(staged, orphan))) {
            renames.push([join(DATA, orphan), join(aside, orphan)]);
        }
    }
    for (const kind of [USER_HOMES_DIR, TEAM_HOMES_DIR]) {
        if (!existsSync(join(staged, kind))) continue;
        for (const id of readdirSync(join(staged, kind))) {
            const [from, live] = [join(staged, kind, id), join(DATA, kind, id)];
            if (!pathExists(live)) {
                renames.push([from, live]);
                continue;
            }
            merged.push(join(kind, id));
            const goingAside = new Set<string>();
            for (const { path, dir } of lightWalk(live)) {
                if (dir) continue;
                goingAside.add(path);
                renames.push([join(live, path), join(aside, kind, id, path)]);
            }
            let moved = '';
            for (const { path, dir } of lightWalk(from)) {
                if (moved && path.startsWith(`${moved}/`)) continue;
                const here = lstatSync(join(live, path), { throwIfNoEntry: false });
                if (dir && here?.isDirectory()) continue;
                // A rename onto a file would replace it, and onto a folder would stop the swap halfway.
                if (here && (here.isDirectory() || !goingAside.has(path))) {
                    return { conflict: `${join(kind, id, path)} is in the way here` };
                }
                renames.push([join(from, path), join(live, path)]);
                moved = path;
            }
        }
    }
    return { renames, merged };
}

// What a Light archive holds of the home at `root`, relative to it, each folder before what is in it.
function lightWalk(root: string): LightEntry[] {
    const held: LightEntry[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            const path = dir ? `${dir}/${entry.name}` : entry.name;
            if (!entry.isDirectory()) held.push({ path, dir: false });
            else if (!isLightSkipped(path)) {
                held.push({ path, dir: true });
                walk(path);
            }
        }
    };
    walk('');
    return held;
}

function pathExists(path: string): boolean {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

// Makes the missing folders above `path` and gives them to `owner`, who owns what moves in: the API's user, as the
// stage made it. Folders owned by root, or by whoever owns data/, which may be root, would lock that user out.
function makeParents(path: string, owner: Owner): void {
    const missing: string[] = [];
    for (let dir = dirname(path); !pathExists(dir); dir = dirname(dir)) missing.unshift(dir);
    for (const dir of missing) {
        mkdirSync(dir, { mode: 0o700 });
        ownAs(dir, owner);
    }
}

// The device a path is on, or would be: that of its nearest folder that is there.
function deviceOf(path: string): number {
    let dir = path;
    while (!pathExists(dir)) dir = dirname(dir);
    return lstatSync(dir).dev;
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

// Copies are made again and renames that already happened are skipped, so a swap cut off anywhere finishes where it
// stopped. A path both moved away and moved back into counts as moved when the later rename is done.
function runSwap(ui: Ui, swap: RestoreSwap): void {
    const cannot = (detail: string): never =>
        ui.fail(
            `The swap of ${swap.archive} stopped halfway and cannot go on: ${detail}.`,
            `${SWAP_MARKER} lists every rename; what went aside is in ${swap.aside.join(', ')}. Put data/ right by hand, then delete ${SWAP_MARKER}.`,
        );
    for (const [from, to] of swap.copies) {
        const source = statSync(from, { throwIfNoEntry: false });
        if (!source) continue;
        makeParents(to, source);
        copyFileSync(from, to);
        ownAs(to, source);
    }
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
            makeParents(to, lstatSync(from));
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
        'level' in value &&
        BACKUP_LEVELS.some((level) => level === value.level) &&
        'appVersion' in value &&
        typeof value.appVersion === 'string' &&
        'orphans' in value &&
        isPaths(value.orphans)
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
        'copies' in value &&
        isMoves(value.copies) &&
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
