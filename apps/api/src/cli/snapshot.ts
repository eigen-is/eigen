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
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { BACKUP_STAMP_PATTERN, buildBackupStamp } from '@workspace/lib/validation';
import type { Subprocess } from 'bun';
import pkg from '../../../../package.json' with { type: 'json' };
import { COLLAB_EPOCH_FILE } from '../lib/collab/epoch';
import { DATA_LOCK_FILE, lockDataDir } from '../lib/config/data-lock';
import { readEnvFile } from './env-file';
import { DECLINED, ENV_PATH, installOwner, ownAs, VERSION } from './install';
import { createUi, glyphLine, type Ui } from './ui';

// Both commands run as root in a container on the install folder (-w /install), so data/ keeps its mixed owners.
const SNAPSHOTS = 'snapshots';
const META = 'eigen-snapshot.json';
// Next to data/, so the swap is two renames on one filesystem; root's alone while it holds what a snapshot brought.
const STAGING = '.eigen/restore';
// What ./eigen rollback goes back to: the pre-update snapshot, and the version and commit that made it.
const LAST_UPDATE = '.eigen/last-update';

type SnapshotMeta = { version: string; createdAt: string };

export const SNAPSHOT_NAME = new RegExp(`^eigen-(?<preUpdate>pre-update-)?${BACKUP_STAMP_PATTERN}\\.tar\\.gz$`);

export const SNAPSHOT_OPTIONS = { 'pre-update': { type: 'boolean' } } as const;
export const SNAPSHOT_USAGE = `Usage: snapshot [--pre-update]

Writes data/ and ${ENV_PATH} into ${SNAPSHOTS}/eigen-<UTC time>.tar.gz. Stop Eigen first: ./eigen backup does.

  --pre-update   Name it eigen-pre-update-<UTC time>.tar.gz, after deleting the pre-update snapshots
                 older than the previous one, and write ${LAST_UPDATE} for ./eigen rollback`;
// --check is the launcher's: it unpacks and checks while Eigen runs, so a refusal stops nothing.
export const RESTORE_OPTIONS = { yes: { type: 'boolean' }, check: { type: 'boolean' } } as const;
export const RESTORE_USAGE = `Usage: ./eigen restore <snapshot> [--yes]

Stops Eigen, puts data/ and ${ENV_PATH} back from a snapshot in ${SNAPSHOTS}/, and starts Eigen again.
The current data/ and ${ENV_PATH} are kept aside.

  --yes   Do not ask`;

// What refusal() looks at; not a setgid folder, which a setgid install folder hands down to every folder in it.
const SUSPECTS = '-type b -o -type c -o -type p -o -type s -o -type f ( -perm -4000 -o -perm -2000 ) -o -type l';

// The snapshots among these file names, newest first by the time in the name, pre-update ones included.
export function newestSnapshots(names: string[]): string[] {
    const stamp = (name: string) => name.replace('pre-update-', '');
    return names.filter((name) => SNAPSHOT_NAME.test(name)).sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

// Held until exit, like the API holds it while it runs: neither reads or replaces data/ while the other does.
let dataLock: Database | null = null;

function lockData(ui: Ui, command: string): void {
    const file = join('data/server', DATA_LOCK_FILE);
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
    if (!lstatSync(join(STAGING, 'data')).isDirectory()) return 'data is not a folder';
    const suspects = Bun.spawn(['find', STAGING, '(', ...SUSPECTS.split(' '), ')', '-print0'], {
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const [listed, code] = await Promise.all([new Response(suspects.stdout).text(), suspects.exited]);
    if (code !== 0) return 'its files cannot be listed';
    const data = realpathSync(join(STAGING, 'data'));
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

export async function snapshot(flags: { 'pre-update'?: boolean }): Promise<void> {
    const ui = await createUi(true);
    if (!existsSync(ENV_PATH) || !existsSync('data')) {
        ui.fail(
            `There is no Eigen install here: ${ENV_PATH} or data/ is missing.`,
            'Run ./eigen backup in the install folder.',
        );
    }
    lockData(ui, 'backup');
    const owner = installOwner('.');
    if (!existsSync(SNAPSHOTS)) mkdirSync(SNAPSHOTS, { mode: 0o700 });
    ownAs(SNAPSHOTS, owner);

    // The older pre-update snapshots go first, so the disk holds two while this one is written.
    if (flags['pre-update']) {
        const older = newestSnapshots(readdirSync(SNAPSHOTS))
            .filter((file) => SNAPSHOT_NAME.exec(file)?.groups?.['preUpdate'])
            .slice(1);
        for (const file of older) rmSync(join(SNAPSHOTS, file));
        if (older.length) console.log(glyphLine('ok', `Removed the older pre-update snapshots: ${older.join(', ')}`));
    }

    // The archive holds every secret of the server: nothing this writes is readable by others, not even briefly.
    process.umask(0o077);
    const createdAt = new Date();
    const name = `eigen-${flags['pre-update'] ? 'pre-update-' : ''}${buildBackupStamp(createdAt)}.tar.gz`;
    const metaDir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    writeFileSync(join(metaDir, META), JSON.stringify({ version: pkg.version, createdAt: createdAt.toISOString() }));
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
            '-C',
            metaDir,
            META,
            '-C',
            process.cwd(),
            ENV_PATH,
            'data',
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
    console.log(
        glyphLine('ok', `Saved ${SNAPSHOTS}/${name} (${formatFileSize(statSync(join(SNAPSHOTS, name)).size)})`),
    );
    if (flags['pre-update']) {
        mkdirSync(dirname(LAST_UPDATE), { recursive: true });
        writeFileSync(LAST_UPDATE, `${name}\n${pkg.version}\n${process.env['EIGEN_COMMIT'] ?? ''}\n`);
        ownAs(LAST_UPDATE, owner);
    }
}

export async function restore(archive = '', flags: { yes?: boolean; check?: boolean }): Promise<void> {
    const ui = await createUi(flags.yes === true);

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
            !VERSION.test(parsed.version) ||
            !('createdAt' in parsed) ||
            typeof parsed.createdAt !== 'string' ||
            Number.isNaN(Date.parse(parsed.createdAt))
        ) {
            return ui.fail(
                `${name} is not an Eigen snapshot: it has no readable ${META}.`,
                'Restore a snapshot made by ./eigen backup.',
            );
        }
        if (readCode !== 0) cannot(readError.trim());
        meta = { version: parsed.version, createdAt: parsed.createdAt };
    }
    if (Bun.semver.order(meta.version, pkg.version) > 0) {
        ui.fail(
            `${name} is a snapshot of Eigen ${meta.version}; this install runs ${pkg.version}.`,
            'Update first, then restore.',
        );
    }

    // The swap is two renames: a linked data/ would move the link, and one on another disk cannot be renamed.
    const data = lstatSync('data', { throwIfNoEntry: false });
    if (data && (data.isSymbolicLink() || data.dev !== statSync('.').dev)) {
        ui.fail(
            'Restore needs data/ as a folder inside the install folder.',
            'Move the data into data/ here, then run ./eigen restore again.',
        );
    }
    if (!flags.check) lockData(ui, 'restore');

    const what = `${name}, a snapshot of Eigen ${meta.version}`;
    if (!flags.yes) {
        const go = await ui.confirm({
            message: `Replace data/ and ${ENV_PATH} with ${what}, made on ${formatDate(meta.createdAt)}, ${formatTimeAgo(meta.createdAt)}? The current ones are kept aside as data.pre-restore-*.`,
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
        extract = Bun.spawn(['tar', '--numeric-owner', '-xzpf', path, '-C', STAGING, ENV_PATH, 'data'], {
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
        // A release install runs the images its .env.production pins; a source install builds its own and pins none.
        const kind = (env: string) =>
            readEnvFile(env).has('EIGEN_VERSION') ? 'a release install' : 'a source install';
        const [theirs, ours] = [kind(join(STAGING, ENV_PATH)), kind(ENV_PATH)];
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
    rmSync(join(STAGING, 'data/server', COLLAB_EPOCH_FILE), { force: true });
    const stamp = buildBackupStamp(new Date());
    const aside: string[] = [];
    for (const current of ['data', ENV_PATH]) {
        if (existsSync(current)) {
            renameSync(current, `${current}.pre-restore-${stamp}`);
            aside.push(`${current}.pre-restore-${stamp}`);
        }
        renameSync(join(STAGING, current), current);
    }
    rmSync(STAGING, { recursive: true });

    console.log(glyphLine('ok', `Restored ${what}`));
    if (aside.length) console.log(glyphLine('ok', `Kept aside: ${aside.join(', ')}`));
}
