import {
    chmodSync,
    chownSync,
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { formatTimeAgo } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { buildBackupStamp, buildSnapshotName, SNAPSHOT_NAME } from '@workspace/lib/validation';
import pkg from '../../../../package.json' with { type: 'json' };
import { createUi, type Ui } from './ui';

// Both commands run as root in a container on the install folder (-w /install), so data/ keeps its mixed owners.
const ENV_PATH = '.env.production';
const BACKUPS = 'backups';
const META = 'eigen-snapshot.json';
// The server's uid:gid, which owns backups/ and reads its archives.
const SERVER_ID = 1000;
const SNAPSHOT_USAGE = `Usage: snapshot [--pre-update]

Writes data/ and ${ENV_PATH} into ${BACKUPS}/eigen-<UTC time>.tar.gz. Stop Eigen first: ./eigen backup does.

  --pre-update   Name it eigen-pre-update-<UTC time>.tar.gz and delete the pre-update snapshots
                 older than the previous one`;
const RESTORE_USAGE = `Usage: restore <snapshot> [--yes] [--check]

Puts data/ and ${ENV_PATH} back from a snapshot in ${BACKUPS}/, and keeps the current ones aside.
Stop Eigen first: ./eigen restore does.

  --yes     Do not ask
  --check   Check the snapshot and ask, but change nothing`;

// Glyph lines like the launcher's steps, colored on a terminal.
function done(text: string): void {
    const glyph = process.stdout.isTTY && !process.env['NO_COLOR'] ? styleText('green', '◇') : '◇';
    console.log(`${glyph}  ${text}`);
}

export async function snapshot(args: string[]): Promise<void> {
    let parsed: { values: { 'pre-update'?: boolean; help?: boolean }; positionals: string[] };
    try {
        parsed = parseArgs({
            args,
            options: { 'pre-update': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
            allowPositionals: true,
        });
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n\n${SNAPSHOT_USAGE}`);
        process.exit(2);
    }
    const { values: flags, positionals } = parsed;
    if (flags.help) {
        console.log(SNAPSHOT_USAGE);
        return;
    }
    if (positionals.length) {
        console.error(SNAPSHOT_USAGE);
        process.exit(2);
    }
    const ui = await createUi(true);
    if (!existsSync(ENV_PATH) || !existsSync('data')) {
        ui.fail(
            `There is no Eigen install here: ${ENV_PATH} or data/ is missing.`,
            'Run ./eigen backup in the install folder.',
        );
    }
    const root = process.getuid?.() === 0;
    if (!existsSync(BACKUPS)) {
        mkdirSync(BACKUPS);
        if (root) chownSync(BACKUPS, SERVER_ID, SERVER_ID);
    }

    // The archive holds every secret of the server: nothing this writes is readable by others, not even briefly.
    process.umask(0o077);
    const createdAt = new Date();
    const name = buildSnapshotName(createdAt, flags['pre-update'] === true);
    const metaDir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    writeFileSync(join(metaDir, META), JSON.stringify({ version: pkg.version, createdAt: createdAt.toISOString() }));
    // One fixed name, so a run that died halfway leaves nothing a later run does not overwrite.
    const partial = join(BACKUPS, '.eigen-snapshot.partial');
    let out: number;
    try {
        out = openSync(partial, 'w', 0o600);
    } catch (error) {
        rmSync(metaDir, { recursive: true });
        return ui.fail(
            `Could not write to ${BACKUPS}/: ${error instanceof Error ? error.message : String(error)}`,
            `Make ${BACKUPS}/ a writable folder, then run ./eigen backup again.`,
        );
    }
    // Numeric owners: the ids in data/ are the containers' users, which this image may not name.
    const tar = Bun.spawn(
        ['tar', '-cf', '-', '--numeric-owner', '-C', metaDir, META, '-C', process.cwd(), ENV_PATH, 'data'],
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
    if (root) chownSync(partial, SERVER_ID, SERVER_ID);
    renameSync(partial, join(BACKUPS, name));
    done(`Saved ${BACKUPS}/${name} (${formatFileSize(statSync(join(BACKUPS, name)).size)})`);

    if (flags['pre-update']) {
        const older = readdirSync(BACKUPS)
            .filter((file) => file !== name && SNAPSHOT_NAME.exec(file)?.groups?.['preUpdate'])
            .sort()
            .slice(0, -1);
        for (const file of older) rmSync(join(BACKUPS, file));
        if (older.length) done(`Removed the older pre-update snapshots: ${older.join(', ')}`);
    }
}

export async function restore(args: string[]): Promise<void> {
    let parsed: { values: { yes?: boolean; check?: boolean; help?: boolean }; positionals: string[] };
    try {
        parsed = parseArgs({
            args,
            options: { yes: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
            allowPositionals: true,
        });
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : String(error)}\n\n${RESTORE_USAGE}`);
        process.exit(2);
    }
    const { values: flags, positionals } = parsed;
    if (flags.help) {
        console.log(RESTORE_USAGE);
        return;
    }
    const [archive = '', ...extra] = positionals;
    if (extra.length) {
        console.error(RESTORE_USAGE);
        process.exit(2);
    }
    const ui: Ui = await createUi(flags.yes === true);

    // Only a snapshot in backups/, named by the file name or its path from the install folder.
    const snapshots = existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((file) => SNAPSHOT_NAME.test(file)) : [];
    const name = basename(archive);
    if (!['.', BACKUPS, `./${BACKUPS}`].includes(dirname(archive)) || !snapshots.includes(name)) {
        ui.fail(
            archive ? `${archive} is not a snapshot in ${BACKUPS}/.` : 'Name the snapshot to restore.',
            snapshots.length
                ? `The newest in ${BACKUPS}/: ${snapshots.sort().reverse().slice(0, 5).join(', ')}`
                : `${BACKUPS}/ has no snapshots; ./eigen backup makes one.`,
        );
    }
    const path = join(BACKUPS, name);

    const read = Bun.spawnSync(['tar', '-xzOf', path, META], { stderr: 'pipe' });
    let meta: unknown = null;
    try {
        meta = JSON.parse(read.stdout.toString());
    } catch {
        // No readable eigen-snapshot.json: refused below.
    }
    if (
        typeof meta !== 'object' ||
        meta === null ||
        !('version' in meta) ||
        typeof meta.version !== 'string' ||
        !('createdAt' in meta) ||
        typeof meta.createdAt !== 'string'
    ) {
        return ui.fail(
            `${name} is not an Eigen snapshot: it has no ${META}.`,
            'Restore a snapshot made by ./eigen backup.',
        );
    }
    if (Bun.semver.order(meta.version, pkg.version) > 0) {
        ui.fail(
            `${name} is a snapshot of Eigen ${meta.version}; this install runs ${pkg.version}.`,
            'Update first, then restore.',
        );
    }

    const what = `${name}, a snapshot of Eigen ${meta.version}`;
    if (!flags.yes) {
        const go = await ui.confirm({
            message: `Replace data/ and ${ENV_PATH} with ${what} made ${formatTimeAgo(meta.createdAt)}? The current ones are kept aside.`,
            initial: false,
            flag: '--yes',
        });
        if (!go) {
            ui.outro('Nothing was changed.');
            process.exit(130);
        }
    }
    if (flags.check) return;

    const envOwner = statSync(existsSync(ENV_PATH) ? ENV_PATH : '.');
    const stamp = buildBackupStamp(new Date());
    const aside: [string, string][] = [];
    for (const current of ['data', ENV_PATH]) {
        if (!existsSync(current)) continue;
        aside.push([current, `${current}.pre-restore-${stamp}`]);
        renameSync(current, `${current}.pre-restore-${stamp}`);
    }
    const extract = Bun.spawnSync(['tar', '--numeric-owner', '-xzpf', path, ENV_PATH, 'data'], { stderr: 'pipe' });
    if (extract.exitCode !== 0) {
        rmSync('data', { recursive: true, force: true });
        rmSync(ENV_PATH, { force: true });
        for (const [current, kept] of aside) renameSync(kept, current);
        ui.fail(`Could not unpack ${name}:\n${extract.stderr.toString().trim()}`, 'Nothing was changed.');
    }
    if (process.getuid?.() === 0) chownSync(ENV_PATH, envOwner.uid, envOwner.gid);
    chmodSync(ENV_PATH, 0o600);

    done(`Restored ${what}`);
    if (aside.length) done(`Kept aside: ${aside.map(([, kept]) => kept).join(', ')}`);
}
