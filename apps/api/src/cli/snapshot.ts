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
import type { Subprocess } from 'bun';
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

type Member = { name: string; type: string; mode: number; target: string };

// Every member of a snapshot and its eigen-snapshot.json, read here rather than from `tar -tv`, whose listing differs
// between GNU tar and bsdtar and cannot tell a name holding " -> " from a link. What tar might read differently from
// this (a bad checksum, sparse files, a global header, no end marker) is refused. gzip, not Bun's DecompressionStream:
// the one tar -z runs, and ten times faster here.
async function readSnapshot(path: string): Promise<{ members: Member[]; meta: string }> {
    const gunzip = Bun.spawn(['gzip', '-dc', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const chunks = gunzip.stdout[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0);
    // The next count bytes, or none kept when keep is false, so a large file never sits in memory.
    const take = async (count: number, keep = true): Promise<Buffer> => {
        const kept: Buffer[] = [];
        let left = count;
        while (left > 0) {
            if (!buffered.length) {
                const next = await chunks.next();
                if (next.done) throw new Error('it is cut off, or not a gzipped tar');
                buffered = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
            }
            const part = buffered.subarray(0, left);
            if (keep) kept.push(part);
            buffered = buffered.subarray(part.length);
            left -= part.length;
        }
        return Buffer.concat(kept);
    };
    const text = (field: Buffer): string => field.toString().replace(/\0.*$/s, '');
    const number = (field: Buffer): number => {
        // GNU's base-256, for sizes above 8 GiB.
        if ((field[0] ?? 0) & 0x80) return field.subarray(1).reduce((value, byte) => value * 256 + byte, 0);
        const digits = text(field).trim();
        if (!/^[0-7]+$/.test(digits)) throw new Error('a tar header is damaged');
        return Number.parseInt(digits, 8);
    };

    const members: Member[] = [];
    let meta = '';
    let pax: Record<string, string> = {};
    let long: Record<string, string> = {};
    try {
        while (true) {
            const header = await take(512);
            if (header.every((byte) => byte === 0)) return { members, meta };
            const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 0x20 : byte), 0);
            if (sum !== number(header.subarray(148, 156))) throw new Error('a tar header is damaged');
            const type = header[156] ? String.fromCharCode(header[156]) : '0';
            // Extended names and pax records belong to the entry after them, a pax size included.
            const extension = type === 'x' || type === 'L' || type === 'K';
            const size =
                extension || pax['size'] === undefined ? number(header.subarray(124, 136)) : Number(pax['size']);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('a tar header is damaged');
            const padding = (512 - (size % 512)) % 512;
            if (extension) {
                if (size > 1 << 20) throw new Error('a tar header is damaged');
                const body = await take(size);
                await take(padding, false);
                if (type !== 'x') {
                    long[type] = text(body);
                    continue;
                }
                for (let at = 0; at < body.length; ) {
                    const space = body.indexOf(0x20, at);
                    const length = Number(body.subarray(at, space).toString());
                    if (space < 0 || !(length > space - at + 1)) throw new Error('a tar header is damaged');
                    const record = body.subarray(space + 1, at + length - 1).toString();
                    const equals = record.indexOf('=');
                    pax[record.slice(0, equals)] = record.slice(equals + 1);
                    at += length;
                }
                if (Object.keys(pax).some((key) => key.startsWith('GNU.sparse'))) {
                    throw new Error('it holds a sparse file');
                }
                continue;
            }
            // Only POSIX ustar splits a long name over prefix and name; GNU's format keeps other fields there.
            const prefix =
                header.subarray(257, 265).toString() === 'ustar\x0000' ? text(header.subarray(345, 500)) : '';
            const name = text(header.subarray(0, 100));
            const member = {
                name: pax['path'] ?? long['L'] ?? (prefix ? `${prefix}/${name}` : name),
                type,
                mode: number(header.subarray(100, 108)),
                target: pax['linkpath'] ?? long['K'] ?? text(header.subarray(157, 257)),
            };
            members.push(member);
            // Tars disagree on whether a link or a folder can carry data; none of ours does.
            if (type !== '0' && size) throw new Error(`${member.name} is a type ${type} entry with data`);
            if (member.name === META && size <= 1 << 16) meta = (await take(size)).toString();
            else await take(size, false);
            await take(padding, false);
            pax = {};
            long = {};
        }
    } finally {
        gunzip.kill();
    }
}

// Why a member has no place in a snapshot, or null. The archive sits in backups/, which the server can write, and
// root unpacks it: a crafted one could otherwise link to ./eigen, plant a setuid file or a device, or point outside.
function refusal({ name, type, mode, target }: Member, links: Set<string>): string | null {
    const path = type === '5' ? name.replace(/\/$/, '') : name;
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return `${name} is not a plain path`;
    if (type === '1') return `${name} is a hard link`;
    if (type === '3' || type === '4') return `${name} is a device`;
    if (type === '6') return `${name} is a fifo`;
    if (!['0', '2', '5'].includes(type)) return `${name} is a tar entry of type ${type}`;
    if (mode & 0o6000) return `${name} is setuid or setgid`;
    if (path === META || path === ENV_PATH) return type === '0' ? null : `${name} is not a file`;
    if (path === 'data') return type === '5' ? null : 'data is not a folder';
    if (parts[0] !== 'data') return `${name} is not in data/`;
    for (let end = 2; end < parts.length; end++) {
        const through = parts.slice(0, end).join('/');
        if (links.has(through)) return `${name} goes through the link ${through}`;
    }
    if (type !== '2') return null;
    if (!target || target.startsWith('/')) return `${name} points outside data/`;
    // Resolved hop by hop: a `..` after a link would climb from wherever that link points.
    const at = parts.slice(0, -1);
    for (const part of target.split('/')) {
        if (links.has(at.join('/'))) return `${name} points through the link ${at.join('/')}`;
        if (part === '..') at.pop();
        else if (part && part !== '.') at.push(part);
        if (at[0] !== 'data') return `${name} points outside data/`;
    }
    return null;
}

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

    const cannot = (reason: string): never =>
        ui.fail(
            `${name} cannot be restored: ${reason}.`,
            'Nothing was changed. Restore a snapshot made by ./eigen backup.',
        );
    let listed: { members: Member[]; meta: string };
    try {
        listed = await readSnapshot(path);
    } catch (error) {
        return cannot(error instanceof Error ? error.message : String(error));
    }
    const links = new Set(listed.members.filter((member) => member.type === '2').map((member) => member.name));
    for (const member of listed.members) {
        const reason = refusal(member, links);
        if (reason) cannot(reason);
    }
    const names = new Set(listed.members.map((member) => member.name.replace(/\/$/, '')));
    if (!names.has(ENV_PATH) || !names.has('data')) cannot(`it holds no ${ENV_PATH} or no data/`);

    let meta: unknown = null;
    try {
        meta = JSON.parse(listed.meta);
    } catch {
        // No readable eigen-snapshot.json: refused below.
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
    // From the first rename on, an interrupt stops tar and the current data goes back; a torn data/ must never stay.
    let interrupted = false;
    let extract: Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    const interrupt = () => {
        interrupted = true;
        extract?.kill();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const aside: [string, string][] = [];
    for (const current of ['data', ENV_PATH]) {
        if (!existsSync(current)) continue;
        aside.push([current, `${current}.pre-restore-${stamp}`]);
        renameSync(current, `${current}.pre-restore-${stamp}`);
    }
    extract = Bun.spawn(['tar', '--numeric-owner', '-xzpf', path, ENV_PATH, 'data'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
    });
    if (interrupted) extract.kill();
    const [code, error] = await Promise.all([extract.exited, new Response(extract.stderr).text()]);
    if (code !== 0 || interrupted) {
        rmSync('data', { recursive: true, force: true });
        rmSync(ENV_PATH, { force: true });
        for (const [current, kept] of aside) renameSync(kept, current);
        if (interrupted) {
            ui.outro('Cancelled. Nothing was changed.');
            process.exit(130);
        }
        ui.fail(`Could not unpack ${name}:\n${error.trim()}`, 'Nothing was changed.');
    }
    if (process.getuid?.() === 0) chownSync(ENV_PATH, envOwner.uid, envOwner.gid);
    chmodSync(ENV_PATH, 0o600);

    done(`Restored ${what}`);
    if (aside.length) done(`Kept aside: ${aside.map(([, kept]) => kept).join(', ')}`);
}
