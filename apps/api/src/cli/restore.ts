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
    writeFileSync,
    writeSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { parseArgs } from 'node:util';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { BACKUP_LEVELS, type BackupLevel } from '@workspace/lib/types/backup';
import { buildBackupStamp } from '@workspace/lib/validation';
import { copyArchiveMember } from '../lib/backup/archive';
import { isLightSkipped } from '../lib/backup/archive-layout';
import { describeError } from '../lib/backup/errors';
import {
    backupsDirPath,
    buildSafetyCopyName,
    freeAt,
    INSTALL_FOLDERS,
    roomShortfall,
    SERVER_ARCHIVE_ENV_MEMBER,
    STAGING_DIR,
} from '../lib/backup/paths';
import {
    RESTORING_DATA_DIR,
    RESTORING_DIR,
    type ServerArchiveFile,
    stageBytesNeeded,
    stageServerArchive,
} from '../lib/backup/restore-server';
import { describeFailures, readServerArchive } from '../lib/backup/verify';
import { DATA_LOCK_FILE, lockDataDir } from '../lib/config/data-lock';
import { getEnvFile } from '../lib/config/env';
import {
    getDataRoot,
    homeDirUnder,
    ORG_HOMES_DIR,
    SERVER_DIR,
    TEAM_HOMES_DIR,
    USER_HOMES_DIR,
} from '../lib/config/paths';
import { API_IMAGE_KEY, PIN_KEYS } from '../lib/config/release';
import { PATHS } from '../lib/core/constants';
import { readEnvFile } from './env-file';
import { BACKUPS, DATA, DECLINED, ENV_PATH, installOwner, ownAs, VERSION, VERSION_PATTERN } from './install';
import { createUi, glyphLine, type Ui } from './ui';

// Two runs, as the launcher makes them. --stage runs as the API's user in its container while Eigen runs, on the
// data root, .env.production and backups folder the API sees. --swap runs as root on the install folder (-w
// /install) with Eigen stopped, like --staged and --env. A refusal in either comes before anything of data/ moves.
export const RESTORE_OPTIONS = {
    stage: { type: 'boolean' },
    staged: { type: 'boolean' },
    swap: { type: 'boolean' },
    env: { type: 'boolean' },
    yes: { type: 'boolean' },
    's3-from-archive': { type: 'boolean' },
} as const;
export const RESTORE_USAGE = `Usage: restore <archive> --stage [--yes] [--s3-from-archive]
       restore --staged
       restore --swap
       restore <archive> --env

Puts a whole-server archive back in two steps, run by ./eigen restore.

  --stage            Unpack and check <archive> (a name in backups/ or a path) into data/${RESTORING_DIR} while
                     Eigen runs. Asks first; a no, or a refusal, leaves data/ as it is
  --yes              Do not ask
  --s3-from-archive  Upload the files an archive with S3 files holds under fresh keys, instead of keeping the
                     bucket as it is
  --staged           Print the staged archive's version, level and the images its ${ENV_PATH} pins
  --swap             With Eigen stopped: swap the staged tree in and keep what it replaces aside. Finishes a swap
                     that was cut off
  --env              On a fresh machine, before the stage: write the ${ENV_PATH} of <archive> here, which pins
                     the build that restores it`;

type Flags = ReturnType<typeof parseArgs<{ options: typeof RESTORE_OPTIONS }>>['values'];

// Written last by the stage, so a stage cut off halfway is never swapped in.
const STAGE_RECORD = 'staged.json';
type StagedRestore = { archive: string; level: BackupLevel; appVersion: string };

// Written by the swap before its first rename, read by the launcher's preflight: while it is there, a swap was cut
// off, and --swap finishes it.
export const SWAP_MARKER = '.eigen/restore-swap';
// Held by a swap from before it reads the marker until it exits: .eigen/ is there all along, data/ is not.
export const SWAP_LOCK = '.eigen/restore.lock';
// In data/.restoring, held by the stage that fills it: a second one would wipe its tree.
export const STAGE_LOCK = 'stage.lock';
// The copies, then the renames in order, from and to, relative to the install folder; `aside` names what the
// operator finds after.
type RestoreSwap = {
    archive: string;
    copies: [string, string][];
    renames: [string, string][];
    aside: string[];
    leftover: string;
    env: boolean;
};

type Held = { path: string; dir: boolean };

// What refusal() looks at; not a setgid folder, which a setgid install folder hands down to every folder in it.
const SUSPECTS = '-type b -o -type c -o -type p -o -type s -o -type f ( -perm -4000 -o -perm -2000 ) -o -type l';

// Held until exit, like the API holds the data lock while it runs. False when another process holds `file`.
const locks: Database[] = [];

function hold(file: string): boolean {
    const lock = lockDataDir(file);
    if (lock) locks.push(lock);
    return lock !== null;
}

// Neither Eigen nor another swap reads or replaces data/ while this one does.
function lockData(ui: Ui): void {
    const file = join(DATA, SERVER_DIR, DATA_LOCK_FILE);
    // Root must not make one the API could not open; without one, no API ever ran on this data/.
    if (existsSync(file) && !hold(file)) {
        ui.fail(
            'data/ is in use by Eigen or by another restore.',
            'Wait for it to finish, then run ./eigen restore again.',
        );
    }
}

const lexists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

// A home's light set, folders before what is in them, relative to the home.
function lightWalk(root: string): Held[] {
    const held: Held[] = [];
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

function isStagedRestore(value: unknown): value is StagedRestore {
    return (
        typeof value === 'object' &&
        value !== null &&
        'archive' in value &&
        typeof value.archive === 'string' &&
        'level' in value &&
        BACKUP_LEVELS.some((level) => level === value.level) &&
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

async function stage(archive: string | undefined, flags: Flags): Promise<void> {
    const ui = await createUi(flags.yes === true);
    if (!archive) return ui.fail('Name the archive to restore.', 'Pick a server archive in backups/.');
    const archivePath = archive.includes('/') ? archive : join(backupsDirPath(), archive);
    if (!statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
        return ui.fail(`${archive} is not a file.`, 'Name a server archive in backups/, or its path.');
    }
    const name = basename(archivePath);
    const dataRoot = getDataRoot();
    const restoring = join(dataRoot, RESTORING_DIR);
    mkdirSync(restoring, { recursive: true, mode: 0o700 });
    if (!hold(join(restoring, STAGE_LOCK))) {
        return ui.fail(
            'Another restore is staging into data/.restoring.',
            'Wait for it to finish, then run ./eigen restore again.',
        );
    }
    // A stage that died halfway left its tree here, with no record: it goes, whatever it holds.
    for (const entry of readdirSync(restoring)) {
        if (entry !== STAGE_LOCK) rmSync(join(restoring, entry), { recursive: true, force: true });
    }
    const refuse = (message: string, next: string): never => {
        rmSync(restoring, { recursive: true, force: true });
        return ui.fail(message, next);
    };

    const read = await readServerArchive(archivePath);
    const manifest = read.manifest;
    if (!manifest) {
        return refuse(
            `${name} is not an Eigen server archive: ${read.verify.failures[0]}.`,
            'Restore an archive made by ./eigen backup.',
        );
    }
    if (read.verify.status !== 'verified') {
        return refuse(`${name} is damaged: ${describeFailures(read.verify)}.`, 'Restore another archive.');
    }
    // Bun.semver.order throws on what is not a version.
    if (!VERSION_PATTERN.test(manifest.appVersion) || Bun.semver.order(manifest.appVersion, VERSION) > 0) {
        return refuse(
            `${name} is an archive of Eigen ${manifest.appVersion}; this install runs ${VERSION}.`,
            'Update first, then restore.',
        );
    }
    if (flags['s3-from-archive'] && manifest.level !== 'full-s3') {
        return refuse(
            `${name} holds no files of S3 buckets, so --s3-from-archive has nothing to upload.`,
            'Leave the flag out.',
        );
    }
    const needed = stageBytesNeeded(manifest);
    const shortfall = roomShortfall(`Staging ${name}`, needed, dataRoot, 'data/');
    if (shortfall) return refuse(`${shortfall}.`, 'Free space on that disk, then run ./eigen restore again.');
    const archived: ServerArchiveFile = {
        name,
        manifest,
        members: new Map(read.members.map((member) => [member.name, member])),
    };

    // An archive without .env.production keeps the one here; with neither, there is nothing to start Eigen with.
    const envMember = archived.members.get(SERVER_ARCHIVE_ENV_MEMBER);
    const current = getEnvFile();
    const hasCurrent = current !== undefined && existsSync(current);
    if (envMember) await copyArchiveMember(envMember, join(restoring, ENV_PATH));
    else if (!hasCurrent) {
        return refuse(`${name} holds no ${ENV_PATH}, and this install has none.`, `Restore an archive that holds one.`);
    }
    // A release install runs the images its .env.production pins; a local build builds its own and pins none.
    if (envMember && current && hasCurrent) {
        const install = (env: string) =>
            readEnvFile(env).has('EIGEN_VERSION') ? 'a release install' : 'a local build';
        const [theirs, ours] = [install(join(restoring, ENV_PATH)), install(current)];
        if (theirs !== ours) {
            return refuse(
                `${name} is an archive of ${theirs}; this is ${ours}.`,
                `Restore it on ${theirs} of Eigen, or restore an archive made here.`,
            );
        }
    }

    const homes = manifest.homes.filter((home) => home.member);
    const failed = manifest.homes.flatMap((home) => (home.failed ? [`${home.name} (${home.failed})`] : []));
    const warned = manifest.homes.flatMap((home) =>
        home.warnings?.length ? [`${home.name} (${home.warnings[0]})`] : [],
    );
    const lines = [
        `A ${manifest.level} archive of Eigen ${manifest.appVersion} for ${manifest.domain}, made on ${formatDate(manifest.createdAt)}, ${formatTimeAgo(manifest.createdAt)}`,
        `${homes.length} homes${failed.length ? `; not in it: ${failed.join(', ')}` : ''}${warned.length ? `; with warnings: ${warned.join(', ')}` : ''}`,
        envMember ? `${ENV_PATH} from the archive` : `No ${ENV_PATH}: the one here stays`,
        manifest.dkim ? 'The DKIM key from the archive' : 'No DKIM key: the one here stays, or mail needs new DNS',
        manifest.certs
            ? 'The mail TLS certificate from the archive'
            : 'No mail TLS certificate: the one here stays, or the mail server makes a self-signed one',
    ];
    if (manifest.level === 'light') {
        const bare = homes.filter((home) => !existsSync(homeDirUnder(dataRoot, home.ownerId))).length;
        lines.push(
            bare
                ? `A light archive holds no files and no mail: ${bare} homes come back without their files and mail`
                : 'A light archive holds no files and no mail: the mail here stays',
            'Files and documents added since drop out of Drive; their bytes stay on disk',
            'Files renamed, moved or trashed since are listed at their old place and do not open',
        );
    }
    ui.note(name, lines);
    if (!flags.yes) {
        const go = await ui.confirm({
            message: `Stage ${name}? Eigen keeps running; data/ is swapped only once it is staged.`,
            initial: false,
            flag: '--yes',
        });
        if (!go) {
            rmSync(restoring, { recursive: true, force: true });
            ui.outro('Nothing was changed.');
            process.exit(DECLINED);
        }
    }

    const notReplayed = await stageServerArchive(archived, restoring, {
        s3FromArchive: flags['s3-from-archive'] === true,
        onStep: (step) => console.log(glyphLine('bar', step)),
    }).catch((error) => refuse(`${name} cannot be restored: ${describeError(error)}.`, 'Restore another archive.'));
    const record: StagedRestore = { archive: name, level: manifest.level, appVersion: manifest.appVersion };
    writeFileSync(join(restoring, STAGE_RECORD), JSON.stringify(record));
    console.log(glyphLine('ok', `Staged ${name} in data/${RESTORING_DIR}`));
    if (notReplayed.settled) {
        console.log(
            glyphLine(
                'warn',
                `${notReplayed.settled} pending upload(s) in the archive are not replayed: data/ here already uploaded, replaced or deleted them`,
            ),
        );
    }
    if (notReplayed.missing) {
        console.log(
            glyphLine(
                'warn',
                `${notReplayed.missing} pending upload(s) are not replayed: the archive does not hold their bytes`,
            ),
        );
    }
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

// Run by the launcher before it stops Eigen, so a swap that cannot rename is refused while Eigen still runs.
async function staged(): Promise<void> {
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

// Why root must not swap the staged tree in, or null; drops the fifos and sockets. The stage writes files and
// folders only, so anything else came from somebody else.
async function refusal(restoring: string): Promise<string | null> {
    const env = lstatSync(join(restoring, ENV_PATH), { throwIfNoEntry: false });
    if (env && (!env.isFile() || env.nlink > 1)) return `${ENV_PATH} is not a plain file`;
    if (!lstatSync(join(restoring, RESTORING_DATA_DIR), { throwIfNoEntry: false })?.isDirectory()) {
        return 'data is not a folder';
    }
    const suspects = Bun.spawn(['find', restoring, '(', ...SUSPECTS.split(' '), ')', '-print0'], {
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

// Light: server/, org/, dkim/ and certs/ go aside whole, the staged ones in. In a home here, every file of its light
// set goes aside first, held by the archive or not: a -wal left beside another database would be replayed onto it.
// A folder only here stays; one only in the archive moves in whole. A home only in the archive moves in whole.
// `merged` are the homes here the archive merges into, relative to data/.
function planLight(
    staged: string,
    aside: string,
): { renames: [string, string][]; merged: string[] } | { conflict: string } {
    const renames: [string, string][] = [];
    const merged: string[] = [];
    for (const top of [SERVER_DIR, ORG_HOMES_DIR, ...INSTALL_FOLDERS.map((folder) => folder.dir)]) {
        if (!existsSync(join(staged, top))) continue;
        if (lexists(join(DATA, top))) renames.push([join(DATA, top), join(aside, top)]);
        renames.push([join(staged, top), join(DATA, top)]);
    }
    for (const kind of [USER_HOMES_DIR, TEAM_HOMES_DIR]) {
        if (!existsSync(join(staged, kind))) continue;
        for (const id of readdirSync(join(staged, kind))) {
            const [from, live] = [join(staged, kind, id), join(DATA, kind, id)];
            if (!lexists(live)) {
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

// The folders missing above `path`, owned like `owner`, what moves in: the stage made every staged item as the API
// user. Root's own, or data/'s, which may be root's, would keep that user out of the homes in them.
function makeParents(path: string, owner: { uid: number; gid: number }): void {
    const missing: string[] = [];
    for (let dir = dirname(path); !lexists(dir); dir = dirname(dir)) missing.unshift(dir);
    for (const dir of missing) {
        mkdirSync(dir, { mode: 0o700 });
        ownAs(dir, owner);
    }
}

// The device a path is on, or would be: that of its nearest folder that is there.
function deviceOf(path: string): number {
    let dir = path;
    while (!lexists(dir)) dir = dirname(dir);
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
        const [fromHere, toHere] = [lexists(from), lexists(to)];
        if (!fromHere && toHere) continue;
        if (fromHere && toHere) {
            const refilled = swap.renames.slice(index + 1).some(([later, onto]) => onto === from && !lexists(later));
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

async function swap(): Promise<void> {
    const ui = await createUi(true);
    mkdirSync(dirname(SWAP_LOCK), { recursive: true });
    if (!hold(SWAP_LOCK)) {
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
    if (!record)
        return ui.fail('Nothing is staged to swap in.', 'Run ./eigen restore <archive>, which stages it first.');
    requireRenamable(ui, record.archive);
    lockData(ui);
    const reason = await refusal(restoring);
    if (reason)
        return ui.fail(
            `The staged ${record.archive} cannot be swapped in: ${reason}.`,
            'Run ./eigen restore <archive> again.',
        );
    const stagedData = join(restoring, RESTORING_DATA_DIR);

    const asideOf = (path: string, at: Date) => buildSafetyCopyName(path, 'pre-restore', buildBackupStamp(at));
    const at = freeAt(
        new Date(),
        (candidate) => lexists(asideOf(DATA, candidate)) || lexists(asideOf(ENV_PATH, candidate)),
    );
    const [dataAside, envAside] = [asideOf(DATA, at), asideOf(ENV_PATH, at)];
    const stagedEnv = join(restoring, ENV_PATH);
    const env = existsSync(stagedEnv);
    const copies: [string, string][] = [];
    const renames: [string, string][] = [];
    if (env && lexists(ENV_PATH)) renames.push([ENV_PATH, envAside]);
    if (env) renames.push([stagedEnv, ENV_PATH]);
    let leftover = restoring;
    if (record.level === 'light') {
        const plan = planLight(stagedData, dataAside);
        if ('conflict' in plan)
            return ui.fail(
                `${record.archive} cannot be swapped in: ${plan.conflict}.`,
                'Move it out of the way, then run ./eigen restore again.',
            );
        renames.push(...plan.renames);
        // Staged uploads stay for the restored rows naming them; reconcile sweeps the rest, so a copy goes aside.
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
        if (lexists(from) && lstatSync(from).dev !== deviceOf(dirname(to))) {
            return ui.fail(
                `${record.archive} cannot be swapped in: ${from} is on another disk than ${dirname(to)}.`,
                'Restore needs data/ and every home in it on the disk of the install folder.',
            );
        }
    }
    // Made before the marker, owned like what moves in: a swap cut off before it plans them again, and finds them there.
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

// No setup runs on a fresh machine: the archive's own file pins the images, Compose's settings and the secrets, and
// setup would write an org the restore throws away.
async function takeEnv(archive: string | undefined): Promise<void> {
    const ui = await createUi(true);
    if (!archive) return ui.fail('Name the archive to restore.', 'Pass the path of a server archive.');
    const name = basename(archive);
    if (existsSync(ENV_PATH)) {
        return ui.fail(`This folder has a ${ENV_PATH} already.`, `./eigen restore restores ${name} onto it.`);
    }
    const read = await readServerArchive(archive);
    if (!read.manifest || read.verify.status !== 'verified') {
        return ui.fail(
            `${name} is not a whole Eigen server archive: ${describeFailures(read.verify)}.`,
            'Restore another archive.',
        );
    }
    const member = read.members.find(({ name }) => name === SERVER_ARCHIVE_ENV_MEMBER);
    if (!member) {
        return ui.fail(
            `${name} holds no ${ENV_PATH}, so it cannot be restored on a fresh machine.`,
            'Run ./eigen setup first, then ./eigen restore.',
        );
    }
    const temporary = `${ENV_PATH}.${process.pid}.tmp`;
    await copyArchiveMember(member, temporary);
    if (!readEnvFile(temporary).has(API_IMAGE_KEY)) {
        rmSync(temporary);
        return ui.fail(
            `${name} is an archive of a local build, which pins no images.`,
            'Restore it in a clone of Eigen, after ./eigen setup.',
        );
    }
    chmodSync(temporary, 0o600);
    ownAs(temporary, installOwner('.'));
    renameSync(temporary, ENV_PATH);
    console.log(glyphLine('ok', `Took ${ENV_PATH} from ${name}`));
}

export async function restore(archive: string | undefined, flags: Flags): Promise<void> {
    const modes = [flags.stage, flags.staged, flags.swap, flags.env].filter(Boolean).length;
    if (modes !== 1 || (!flags.stage && !flags.env && archive !== undefined)) {
        console.error(
            `Pass one of --stage, --staged, --swap or --env; only --stage and --env take an archive.\n\n${RESTORE_USAGE}`,
        );
        process.exit(2);
    }
    if (flags.env) return takeEnv(archive);
    if (flags.stage) return stage(archive, flags);
    if (flags.staged) return staged();
    return swap();
}
