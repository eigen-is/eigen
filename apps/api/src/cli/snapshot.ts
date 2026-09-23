import {
    chmodSync,
    chownSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
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
import { formatDate } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { BACKUP_STAMP_PATTERN, buildBackupStamp } from '@workspace/lib/validation';
import type { Subprocess } from 'bun';
import pkg from '../../../../package.json' with { type: 'json' };
import { createUi, glyphLine } from './ui';

// Both commands run as root in a container on the install folder (-w /install), so data/ keeps its mixed owners.
const ENV_PATH = '.env.production';
const SNAPSHOTS = 'snapshots';
const META = 'eigen-snapshot.json';
// Next to data/, so the swap is two renames on one filesystem; root's alone while it holds what a snapshot brought.
const STAGING = '.eigen/restore';
// The exit code of a restore the operator said no to, which the launcher ends as a plain exit.
const DECLINED = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SNAPSHOT_NAME = new RegExp(`^eigen-(?<preUpdate>pre-update-)?${BACKUP_STAMP_PATTERN}\\.tar\\.gz$`);

export const SNAPSHOT_OPTIONS = { 'pre-update': { type: 'boolean' } } as const;
export const SNAPSHOT_USAGE = `Usage: snapshot [--pre-update]

Writes data/ and ${ENV_PATH} into ${SNAPSHOTS}/eigen-<UTC time>.tar.gz. Stop Eigen first: ./eigen backup does.

  --pre-update   Name it eigen-pre-update-<UTC time>.tar.gz, after deleting the pre-update snapshots
                 older than the previous one`;
// --check is the launcher's half of the seam explained at restore() in ./eigen.
export const RESTORE_OPTIONS = { yes: { type: 'boolean' }, check: { type: 'boolean' } } as const;
export const RESTORE_USAGE = `Usage: ./eigen restore <snapshot> [--yes]

Stops Eigen, puts data/ and ${ENV_PATH} back from a snapshot in ${SNAPSHOTS}/, and starts Eigen again.
The current data/ and ${ENV_PATH} are kept aside.

  --yes   Do not ask`;

// What refusal() looks at: devices, fifos, sockets, setuid or setgid files, and links. Not a setgid folder: a setgid
// install folder hands g+s down to every folder in it.
const SUSPECTS = '-type b -o -type c -o -type p -o -type s -o -type f ( -perm -4000 -o -perm -2000 ) -o -type l';

// Newest first by the time in the name, whether or not it is a pre-update one.
const byStamp = (a: string, b: string) => b.replace('pre-update-', '').localeCompare(a.replace('pre-update-', ''));

// Why the unpacked snapshot has no place in data/, or null. Root unpacked it and the server runs on it: no device,
// fifo, socket, setuid or setgid file, or link that leads out of data/. A hard link in data/ is fine (Dovecot makes
// them on an IMAP copy): tar links only to what it unpacked into STAGING, and the env file must be linked nowhere.
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
        else return `${name} is a device, fifo or socket`;
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
    // The launcher makes snapshots/ as the operator; the archives are theirs too.
    const owner = statSync('.');
    const root = process.getuid?.() === 0;
    if (!existsSync(SNAPSHOTS)) mkdirSync(SNAPSHOTS, { mode: 0o700 });
    if (root) chownSync(SNAPSHOTS, owner.uid, owner.gid);

    // The previous pre-update snapshot stays for a rollback of the last update; the ones before go first, so the disk
    // holds two while this one is written.
    if (flags['pre-update']) {
        const older = readdirSync(SNAPSHOTS)
            .filter((file) => SNAPSHOT_NAME.exec(file)?.groups?.['preUpdate'])
            .sort(byStamp)
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
    let out: number;
    try {
        out = openSync(partial, 'w', 0o600);
    } catch (error) {
        rmSync(metaDir, { recursive: true });
        return ui.fail(
            `Could not write to ${SNAPSHOTS}/: ${error instanceof Error ? error.message : String(error)}`,
            `Make ${SNAPSHOTS}/ a writable folder, then run ./eigen backup again.`,
        );
    }
    // Numeric owners: the ids in data/ are the containers' users, which this image may not name. -S keeps a sparse
    // file small instead of writing out its holes.
    const tar = Bun.spawn(
        ['tar', '-cf', '-', '-S', '--numeric-owner', '-C', metaDir, META, '-C', process.cwd(), ENV_PATH, 'data'],
        { stdout: 'pipe', stderr: 'pipe' },
    );
    const gzip = Bun.spawn(['gzip', '-1'], { stdin: tar.stdout, stdout: out, stderr: 'pipe' });
    const [tarCode, gzipCode, tarError, gzipError] = await Promise.all([
        tar.exited,
        gzip.exited,
        new Response(tar.stderr).text(),
        new Response(gzip.stderr).text(),
    ]);
    closeSync(out);
    rmSync(metaDir, { recursive: true });
    if (tarCode !== 0 || gzipCode !== 0) {
        rmSync(partial, { force: true });
        ui.fail(
            `Could not write the snapshot:\n${tarError}${gzipError}`.trim(),
            'Fix what it says, then run ./eigen backup again.',
        );
    }
    chmodSync(partial, 0o600);
    if (root) chownSync(partial, owner.uid, owner.gid);
    renameSync(partial, join(SNAPSHOTS, name));
    console.log(
        glyphLine('ok', `Saved ${SNAPSHOTS}/${name} (${formatFileSize(statSync(join(SNAPSHOTS, name)).size)})`),
    );
}

export async function restore(archive = '', flags: { yes?: boolean; check?: boolean }): Promise<void> {
    const ui = await createUi(flags.yes === true);

    // Only a snapshot in snapshots/, named by the file name or its path from the install folder.
    const snapshots = existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS).filter((file) => SNAPSHOT_NAME.test(file)) : [];
    const name = basename(archive);
    if (!['.', SNAPSHOTS, `./${SNAPSHOTS}`].includes(dirname(archive)) || !snapshots.includes(name)) {
        ui.fail(
            archive ? `${archive} is not a snapshot in ${SNAPSHOTS}/.` : 'Name the snapshot to restore.',
            snapshots.length
                ? `Pick one of the newest: ${snapshots.sort(byStamp).slice(0, 5).join(', ')}`
                : `${SNAPSHOTS}/ has no snapshots. Run ./eigen backup to make one.`,
        );
    }
    const path = join(SNAPSHOTS, name);
    const cannot = (reason: string): never =>
        ui.fail(`${name} cannot be restored: ${reason}.`, 'Restore a snapshot made by ./eigen backup.');

    // Reads the whole archive, so a damaged one is refused before the question.
    const read = Bun.spawn(['tar', '-xzOf', path, META], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [text, readError, readCode] = await Promise.all([
        new Response(read.stdout).text(),
        new Response(read.stderr).text(),
        read.exited,
    ]);
    let meta: unknown = null;
    try {
        meta = JSON.parse(text);
    } catch {
        // Refused below.
    }
    if (
        typeof meta !== 'object' ||
        meta === null ||
        !('version' in meta) ||
        typeof meta.version !== 'string' ||
        // Bun.semver.order throws on what is not a version.
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(meta.version) ||
        !('createdAt' in meta) ||
        typeof meta.createdAt !== 'string' ||
        Number.isNaN(Date.parse(meta.createdAt))
    ) {
        return ui.fail(
            `${name} is not an Eigen snapshot: it has no readable ${META}.`,
            'Restore a snapshot made by ./eigen backup.',
        );
    }
    if (readCode !== 0) cannot(readError.trim());
    if (Bun.semver.order(meta.version, pkg.version) > 0) {
        ui.fail(
            `${name} is a snapshot of Eigen ${meta.version}; this install runs ${pkg.version}.`,
            'Update first, then restore.',
        );
    }

    // The swap is two renames next to data/: a link would move instead of the data, and a data/ on another disk cannot
    // be renamed at all.
    const data = lstatSync('data', { throwIfNoEntry: false });
    if (data && (data.isSymbolicLink() || data.dev !== statSync('.').dev)) {
        ui.fail(
            'Restore needs data/ as a folder inside the install folder.',
            'Move the data into data/ here, then run ./eigen restore again.',
        );
    }

    const what = `${name}, a snapshot of Eigen ${meta.version}`;
    if (!flags.yes) {
        const days = Math.floor((Date.now() - Date.parse(meta.createdAt)) / DAY_MS);
        const age = days < 1 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
        const go = await ui.confirm({
            message: `Replace data/ and ${ENV_PATH} with ${what}, made ${age} on ${formatDate(meta.createdAt)}? The current ones are kept aside as data.pre-restore-*.`,
            initial: false,
            flag: '--yes',
        });
        if (!go) {
            ui.outro('Nothing was changed.');
            process.exit(DECLINED);
        }
    }
    // The --check run unpacks and checks aside and names the snapshot in the marker; the swap run takes a copy so
    // marked as it is (the seam is explained at restore() in ./eigen). An interrupt before the swap leaves the live
    // data untouched; the handler also holds one during the swap, which is synchronous, until the swap is done.
    let interrupted = false;
    let extract: Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
    const interrupt = () => {
        interrupted = true;
        extract?.kill();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const marker = join(STAGING, '.snapshot');
    if (flags.check || !existsSync(marker) || readFileSync(marker, 'utf8') !== name) {
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
        if (flags.check) {
            writeFileSync(marker, name);
            return;
        }
    }

    const envOwner = statSync(existsSync(ENV_PATH) ? ENV_PATH : '.');
    const staged = join(STAGING, ENV_PATH);
    if (process.getuid?.() === 0) chownSync(staged, envOwner.uid, envOwner.gid);
    chmodSync(staged, 0o600);
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
