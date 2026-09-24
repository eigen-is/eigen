import type { Database } from 'bun:sqlite';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statfsSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { BACKUP_STAMP_PATTERN, buildBackupStamp, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import type { Subprocess } from 'bun';
import { COLLAB_EPOCH_FILE } from '../lib/collab/epoch';
import { DATA_LOCK_FILE, lockDataDir } from '../lib/config/data-lock';
import { SERVER_DIR } from '../lib/config/paths';
import { PATHS } from '../lib/core/constants';
import { readEnvFile } from './env-file';
import { DECLINED, ENV_PATH, installOwner, ownAs, VERSION, VERSION_PATTERN } from './install';
import { createUi, glyphLine, type Ui } from './ui';
import { notesSince } from './update-check';

// Both commands run as root in a container on the install folder (-w /install), so data/ keeps its mixed owners.
const SNAPSHOTS = 'snapshots';
const DATA = 'data';
const META = 'eigen-snapshot.json';
// Next to data/, so the swap is two renames on one filesystem; root's alone while it holds what a snapshot brought.
const STAGING = '.eigen/restore';
// What ./eigen rollback goes back to, as key=value lines the launcher reads: the pre-update snapshot, its kind, and
// the version and commit that made it.
const LAST_UPDATE = '.eigen/last-update';
const KEEP = 3;
// A light snapshot leaves out the folders under every home that hold its files and mail: each mount's file tree, beside
// the mount's own databases, and the Maildir.
const LIGHT_SKIPS = new RegExp(
    `^${DATA}/(?!${SERVER_DIR}/)[^/]+/[^/]+/(?:${PATHS.DRIVE.ROOT}/[^/]+/[^/]+|${PATHS.MAIL.ROOT}/${PATHS.MAIL.MAILDIR})$`,
);

type SnapshotKind = 'full' | 'light';
type SnapshotMeta = { version: string; createdAt: string; kind: SnapshotKind };
type Held = { path: string; dir: boolean };

// The kind is in the name, so retention and status tell them apart without opening one; restore reads the archive's.
export const SNAPSHOT_NAME = new RegExp(
    `^eigen-(?<preUpdate>pre-update-)?(?<light>light-)?(?<stamp>${BACKUP_STAMP_PATTERN})\\.tar\\.gz$`,
);

export const SNAPSHOT_OPTIONS = {
    light: { type: 'boolean' },
    keep: { type: 'string' },
    'pre-update': { type: 'boolean' },
    check: { type: 'boolean' },
    from: { type: 'string' },
} as const;
export const SNAPSHOT_USAGE = `Usage: snapshot [--light] [--keep <n>] [--pre-update] [--check [--from <version>]]

Writes data/ and ${ENV_PATH} into ${SNAPSHOTS}/eigen-<UTC time>.tar.gz, a full snapshot. Stop Eigen first:
./eigen backup does.

  --light            Only the databases and config, as eigen-light-<UTC time>.tar.gz: every home's files and mail
                     stay out
  --keep <n>         Then delete all but the newest <n> of its kind made without --pre-update (default ${KEEP})
  --pre-update       Name it eigen-pre-update-[light-]<UTC time>.tar.gz, after deleting the pre-update snapshots of
                     its kind older than the previous one, and write ${LAST_UPDATE} for ./eigen rollback
  --check            Write nothing: check that ${SNAPSHOTS}/ has room for it, and print kind=full or kind=light
  --from <version>   With --check: full after all when a release since <version> has breaking changes`;
// --check and --checked are the launcher's: it unpacks and checks while Eigen runs, so a refusal stops nothing, then
// reads the version of what it checked.
export const RESTORE_OPTIONS = {
    yes: { type: 'boolean' },
    check: { type: 'boolean' },
    checked: { type: 'boolean' },
} as const;
export const RESTORE_USAGE = `Usage: ./eigen restore <snapshot> [--yes]

Stops Eigen, puts data/ and ${ENV_PATH} back from a snapshot in ${SNAPSHOTS}/, and starts Eigen again. A light
snapshot puts back only the databases and config it holds, and leaves files and mail as they are. What it replaces
is kept aside.

  --yes   Do not ask`;

// What refusal() looks at; not a setgid folder, which a setgid install folder hands down to every folder in it.
const SUSPECTS = '-type b -o -type c -o -type p -o -type s -o -type f ( -perm -4000 -o -perm -2000 ) -o -type l';

// The snapshots among these file names, newest first by the time in the name, of both kinds and pre-update ones too.
export function newestSnapshots(names: string[]): string[] {
    const stamp = (name: string) => SNAPSHOT_NAME.exec(name)?.groups?.['stamp'] ?? '';
    return names.filter((name) => SNAPSHOT_NAME.test(name)).sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

// Held until exit, like the API holds it while it runs: neither reads or replaces data/ while the other does.
let dataLock: Database | null = null;

function lockData(ui: Ui, command: string): void {
    const file = join(DATA, SERVER_DIR, DATA_LOCK_FILE);
    // Root must not make one the API could not open; without one, no API ever ran on this data/.
    if (!existsSync(file)) return;
    dataLock = lockDataDir(file);
    if (!dataLock) {
        ui.fail(
            'data/ is in use by Eigen or by another backup or restore.',
            `Wait for it to finish, then run ./eigen ${command} again.`,
        );
    }
}

// Why root must not swap the copy in, or null; drops the fifos and sockets the API can make. Dovecot makes hard links.
async function refusal(): Promise<string | null> {
    const env = lstatSync(join(STAGING, ENV_PATH));
    if (!env.isFile() || env.nlink > 1) return `${ENV_PATH} is not a plain file`;
    if (!lstatSync(join(STAGING, DATA)).isDirectory()) return 'data is not a folder';
    const suspects = Bun.spawn(['find', STAGING, '(', ...SUSPECTS.split(' '), ')', '-print0'], {
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const [listed, code] = await Promise.all([new Response(suspects.stdout).text(), suspects.exited]);
    if (code !== 0) return 'its files cannot be listed';
    const data = realpathSync(join(STAGING, DATA));
    for (const path of listed.split('\0').filter(Boolean)) {
        const stat = lstatSync(path);
        const name = relative(STAGING, path);
        if (stat.isSymbolicLink()) {
            let target = '';
            try {
                target = realpathSync(path);
            } catch {
                // Leads nowhere yet, so it could lead anywhere later.
            }
            if (target !== data && !target.startsWith(`${data}/`)) return `${name} is a link that leads out of data/`;
        } else if (stat.isFile()) return `${name} is setuid or setgid`;
        else if (stat.isFIFO() || stat.isSocket()) rmSync(path);
        else return `${name} is a device`;
    }
    return null;
}

// data/ under `root` as a light snapshot sees it: the paths it holds, every folder before what is in it.
function lightWalk(root = '.'): Held[] {
    const held: Held[] = [];
    const walk = (dir: string) => {
        held.push({ path: dir, dir: true });
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (!entry.isDirectory()) held.push({ path, dir: false });
            else if (!LIGHT_SKIPS.test(path)) walk(path);
        }
    };
    walk(DATA);
    return held;
}

export async function snapshot(flags: {
    light?: boolean;
    keep?: string;
    'pre-update'?: boolean;
    check?: boolean;
    from?: string;
}): Promise<void> {
    const ui = await createUi(true);
    if (!existsSync(ENV_PATH) || !existsSync(DATA)) {
        ui.fail(
            `There is no Eigen install here: ${ENV_PATH} or data/ is missing.`,
            'Run ./eigen backup in the install folder.',
        );
    }
    const keep = Number(flags.keep ?? KEEP);
    if (!Number.isInteger(keep) || keep < 1) ui.fail('--keep takes a number of snapshots, like 3.', 'Pass --keep 3.');
    const from = flags.from;
    if (from !== undefined && !VERSION_PATTERN.test(from)) {
        ui.fail('--from takes a version, like 0.2.0.', 'Run it through ./eigen update.');
    }
    // A breaking release may convert what a light snapshot leaves out, so only a full one could bring it back.
    const kind: SnapshotKind =
        flags.light && !(from && notesSince(from).some(({ breaking }) => breaking.length)) ? 'light' : 'full';
    const owner = installOwner('.');
    if (!existsSync(SNAPSHOTS)) mkdirSync(SNAPSHOTS, { mode: 0o700 });
    ownAs(SNAPSHOTS, owner);

    // What the files take on disk, as du counts it: the most a snapshot of them can take.
    if (flags.check) {
        let needed = 0;
        if (kind === 'light') {
            // A -wal goes when its Home idles, which it may do mid-walk while Eigen runs.
            needed = lightWalk().reduce(
                (sum, { path }) => sum + (lstatSync(path, { throwIfNoEntry: false })?.blocks ?? 0) / 2,
                0,
            );
        } else {
            const du = Bun.spawn(['du', '-sk', DATA], { stdout: 'pipe', stderr: 'ignore' });
            const [listed] = await Promise.all([new Response(du.stdout).text(), du.exited]);
            needed = Number.parseInt(listed, 10);
        }
        const { bavail, bsize } = statfsSync(SNAPSHOTS);
        const free = (bavail * bsize) / 1024;
        if (!(needed <= free)) {
            ui.fail(
                `The ${kind} snapshot needs up to ${formatFileSize(needed * 1024)}; ${SNAPSHOTS}/ has ${formatFileSize(free * 1024)} free.`,
                `Free space on that disk, or delete old snapshots from ${SNAPSHOTS}/.`,
            );
        }
        console.log(`kind=${kind}`);
        return;
    }
    lockData(ui, 'backup');
    // Retention counts per kind, so light backups never delete the last full one.
    const alike = (file: string) => {
        const groups = SNAPSHOT_NAME.exec(file)?.groups;
        return (
            Boolean(groups?.['preUpdate']) === Boolean(flags['pre-update']) &&
            Boolean(groups?.['light']) === (kind === 'light')
        );
    };

    // The older pre-update snapshots go first, so the disk holds two while this one is written.
    if (flags['pre-update']) {
        const older = newestSnapshots(readdirSync(SNAPSHOTS)).filter(alike).slice(1);
        for (const file of older) rmSync(join(SNAPSHOTS, file));
        if (older.length) console.log(glyphLine('ok', `Removed the older pre-update snapshots: ${older.join(', ')}`));
    }

    // The archive holds every secret of the server: nothing this writes is readable by others, not even briefly.
    process.umask(0o077);
    const createdAt = new Date();
    const prefix = `${flags['pre-update'] ? 'pre-update-' : ''}${kind === 'light' ? 'light-' : ''}`;
    const name = `eigen-${prefix}${buildBackupStamp(createdAt)}.tar.gz`;
    const metaDir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    const meta: SnapshotMeta = { version: VERSION, createdAt: createdAt.toISOString(), kind };
    writeFileSync(join(metaDir, META), JSON.stringify(meta));
    // The API names folders, so a light one hands tar the walk's paths verbatim, not patterns to leave out.
    const members = join(metaDir, 'members');
    if (kind === 'light') writeFileSync(members, Array.from(lightWalk(), ({ path }) => path).join('\0'));
    // One fixed name, so a run that died halfway leaves nothing a later run does not overwrite.
    const partial = join(SNAPSHOTS, '.eigen-snapshot.partial');
    // Numeric owners: data/ holds the containers' ids, which this image may not name. -S keeps a sparse file small.
    const tar = Bun.spawn(
        [
            'tar',
            '--use-compress-program=gzip -1',
            '-cf',
            partial,
            '-S',
            '--numeric-owner',
            // bsdtar reads -T before every other name, wherever it stands.
            ...(kind === 'light'
                ? ['--no-recursion', '--null', '-T', members, ENV_PATH, '-C', metaDir, META]
                : ['-C', metaDir, META, '-C', process.cwd(), ENV_PATH, DATA]),
        ],
        { stdout: 'ignore', stderr: 'pipe' },
    );
    const [code, error] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    rmSync(metaDir, { recursive: true });
    if (code !== 0) {
        rmSync(partial, { recursive: true, force: true });
        ui.fail(`Could not write the snapshot:\n${error}`.trim(), 'Fix what it says, then run ./eigen backup again.');
    }
    chmodSync(partial, 0o600);
    ownAs(partial, owner);
    renameSync(partial, join(SNAPSHOTS, name));
    const size = formatFileSize(statSync(join(SNAPSHOTS, name)).size);
    const described = kind === 'light' ? 'light: databases and config' : 'full';
    console.log(glyphLine('ok', `Saved ${SNAPSHOTS}/${name} (${described}, ${size})`));
    if (flags['pre-update']) {
        mkdirSync(dirname(LAST_UPDATE), { recursive: true });
        const commit = process.env['EIGEN_COMMIT'] ?? '';
        writeFileSync(LAST_UPDATE, `archive=${name}\nversion=${VERSION}\ncommit=${commit}\nkind=${kind}\n`);
        ownAs(LAST_UPDATE, owner);
        return;
    }
    // After this one is written, so a failed snapshot never costs an older one.
    const older = newestSnapshots(readdirSync(SNAPSHOTS)).filter(alike).slice(keep);
    for (const file of older) rmSync(join(SNAPSHOTS, file));
    if (older.length) console.log(glyphLine('ok', `Removed the older snapshots: ${older.join(', ')}`));
}

// Every file of the light set here goes aside first, held by the snapshot or not: a database's -wal left beside the
// one it came with would be replayed onto another. A folder only here stays; one only in the snapshot moves in whole.
function swapLight(staged: Held[], aside: string): void {
    for (const { path, dir } of lightWalk()) {
        if (dir) continue;
        const target = join(aside, relative(DATA, path));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        renameSync(path, target);
    }
    let moved = '';
    for (const { path, dir } of staged) {
        if (moved && path.startsWith(`${moved}/`)) continue;
        if (dir && lstatSync(path, { throwIfNoEntry: false })) continue;
        renameSync(join(STAGING, path), path);
        moved = path;
    }
}

export async function restore(
    archive = '',
    flags: { yes?: boolean; check?: boolean; checked?: boolean },
): Promise<void> {
    const ui = await createUi(flags.yes === true || flags.checked === true);

    // Only a snapshot in snapshots/, named by the file name or its path from the install folder.
    const snapshots = newestSnapshots(existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS) : []);
    const name = basename(archive);
    if (!['.', SNAPSHOTS, `./${SNAPSHOTS}`].includes(dirname(archive)) || !snapshots.includes(name)) {
        ui.fail(
            archive ? `${archive} is not a snapshot in ${SNAPSHOTS}/.` : 'Name the snapshot to restore.',
            snapshots.length
                ? `Pick one of the newest: ${snapshots.slice(0, 5).join(', ')}`
                : `${SNAPSHOTS}/ has no snapshots. Run ./eigen backup to make one.`,
        );
    }
    const path = join(SNAPSHOTS, name);
    const cannot = (reason: string): never =>
        ui.fail(`${name} cannot be restored: ${reason}.`, 'Restore a snapshot made by ./eigen backup.');

    // A --check run read the whole archive and left what it holds beside the copy it unpacked.
    const marker = join(STAGING, '.snapshot');
    const marked: (SnapshotMeta & { name: string }) | null =
        !flags.check && existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
    if (flags.checked) {
        if (marked?.name !== name)
            return ui.fail(`${name} is not checked yet.`, 'Run ./eigen restore, which checks it.');
        console.log(`version=${marked.version}\nkind=${marked.kind}`);
        return;
    }
    let meta: SnapshotMeta;
    if (marked?.name === name) {
        meta = marked;
    } else {
        // Reads the whole archive, so a damaged one is refused before the question.
        const read = Bun.spawn(['tar', '-xzOf', path, META], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const [text, readError, readCode] = await Promise.all([
            new Response(read.stdout).text(),
            new Response(read.stderr).text(),
            read.exited,
        ]);
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            // Refused below.
        }
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('version' in parsed) ||
            typeof parsed.version !== 'string' ||
            // Bun.semver.order throws on what is not a version.
            !VERSION_PATTERN.test(parsed.version) ||
            !('createdAt' in parsed) ||
            typeof parsed.createdAt !== 'string' ||
            Number.isNaN(Date.parse(parsed.createdAt)) ||
            // Snapshots from before there were two kinds hold everything.
            ('kind' in parsed && parsed.kind !== 'full' && parsed.kind !== 'light')
        ) {
            return ui.fail(
                `${name} is not an Eigen snapshot: it has no readable ${META}.`,
                'Restore a snapshot made by ./eigen backup.',
            );
        }
        if (readCode !== 0) cannot(readError.trim());
        const kind = 'kind' in parsed && parsed.kind === 'light' ? 'light' : 'full';
        meta = { version: parsed.version, createdAt: parsed.createdAt, kind };
    }
    if (Bun.semver.order(meta.version, VERSION) > 0) {
        ui.fail(
            `${name} is a snapshot of Eigen ${meta.version}; this install runs ${VERSION}.`,
            'Update first, then restore.',
        );
    }

    // The swap is renames: a linked data/ would move the link, and one on another disk cannot be renamed.
    const data = lstatSync(DATA, { throwIfNoEntry: false });
    if (data && (data.isSymbolicLink() || data.dev !== statSync('.').dev)) {
        ui.fail(
            'Restore needs data/ as a folder inside the install folder.',
            'Move the data into data/ here, then run ./eigen restore again.',
        );
    }
    if (!flags.check) lockData(ui, 'restore');

    const what = `${name}, a ${meta.kind} snapshot of Eigen ${meta.version}`;
    if (!flags.yes) {
        const when = `made on ${formatDate(meta.createdAt)}, ${formatTimeAgo(meta.createdAt)}`;
        const go = await ui.confirm({
            message:
                meta.kind === 'light'
                    ? `Put back the databases and config of data/ and ${ENV_PATH} from ${what}, ${when}? Files and mail stay as they are; what it replaces is kept aside as data.pre-restore-*.`
                    : `Replace data/ and ${ENV_PATH} with ${what}, ${when}? The current ones are kept aside as data.pre-restore-*.`,
            initial: false,
            flag: '--yes',
        });
        if (!go) {
            ui.outro('Nothing was changed.');
            process.exit(DECLINED);
        }
    }
    // --check unpacks, checks and marks a copy, which the swap run takes. No interrupt splits the synchronous swap.
    let interrupted = false;
    let extract: Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
    const interrupt = () => {
        interrupted = true;
        extract?.kill();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    if (marked?.name !== name) {
        rmSync(STAGING, { recursive: true, force: true });
        mkdirSync(STAGING, { recursive: true, mode: 0o700 });
        extract = Bun.spawn(['tar', '--numeric-owner', '-xzpf', path, '-C', STAGING, ENV_PATH, DATA], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'pipe',
        });
        if (interrupted) extract.kill();
        const [code, error] = await Promise.all([extract.exited, new Response(extract.stderr).text()]);
        const reason = interrupted || code !== 0 ? null : await refusal();
        if (interrupted || code !== 0 || reason) rmSync(STAGING, { recursive: true, force: true });
        if (interrupted) {
            ui.outro('Cancelled. Nothing was changed.');
            process.exit(130);
        }
        // The whole archive read cleanly above: this is a full disk, most often. tar's first line names the cause.
        if (code !== 0) {
            ui.fail(
                `Unpacking failed: ${error.trim().split('\n')[0]}`,
                'Fix what it says, then run ./eigen restore again.',
            );
        }
        if (reason) cannot(reason);
        // A folder here where a light snapshot holds a file would stop its swap halfway.
        const conflict =
            meta.kind === 'light'
                ? lightWalk(STAGING).find(
                      ({ path, dir }) => !dir && lstatSync(path, { throwIfNoEntry: false })?.isDirectory(),
                  )
                : undefined;
        if (conflict) {
            rmSync(STAGING, { recursive: true, force: true });
            cannot(`${conflict.path} is a folder here and a file in the snapshot`);
        }
        // A release install runs the images its .env.production pins; a source install builds its own and pins none.
        const install = (env: string) =>
            readEnvFile(env).has('EIGEN_VERSION') ? 'a release install' : 'a source install';
        const [theirs, ours] = [install(join(STAGING, ENV_PATH)), install(ENV_PATH)];
        if (theirs !== ours) {
            rmSync(STAGING, { recursive: true, force: true });
            ui.fail(
                `${name} is a snapshot of ${theirs}; this is ${ours}.`,
                `Restore it on ${theirs} of Eigen, or restore a snapshot made here.`,
            );
        }
        if (flags.check) {
            writeFileSync(marker, JSON.stringify({ name, ...meta }));
            return;
        }
    }

    const staged = join(STAGING, ENV_PATH);
    ownAs(staged, installOwner('.'));
    chmodSync(staged, 0o600);
    // Without it the next start draws a new collab epoch: a tab that loaded a document before reloads, not merges back.
    rmSync(join(STAGING, DATA, SERVER_DIR, COLLAB_EPOCH_FILE), { force: true });
    const stamp = buildBackupStamp(new Date());
    const [dataAside, envAside] = [DATA, ENV_PATH].map((current) => `${current}${PRE_RESTORE_SUFFIX}${stamp}`);
    if (meta.kind === 'light') swapLight(lightWalk(STAGING), dataAside);
    else if (existsSync(DATA)) renameSync(DATA, dataAside);
    if (existsSync(ENV_PATH)) renameSync(ENV_PATH, envAside);
    for (const current of meta.kind === 'light' ? [ENV_PATH] : [DATA, ENV_PATH]) {
        renameSync(join(STAGING, current), current);
    }
    rmSync(STAGING, { recursive: true });

    console.log(
        glyphLine(
            'ok',
            meta.kind === 'light'
                ? `Restored ${what}: databases and config restored; files and mail kept as they are`
                : `Restored ${what}`,
        ),
    );
    const aside = [dataAside, envAside].filter((file) => existsSync(file));
    if (aside.length) console.log(glyphLine('ok', `Kept aside: ${aside.join(', ')}`));
}
