import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseBackupStamp } from '@workspace/lib/validation';
import pkg from '../../../../../package.json' with { type: 'json' };
import { SNAPSHOT_NAME } from '../../cli/snapshot';
import { COLLAB_EPOCH_FILE } from '../../lib/collab/epoch';
import { DATA_LOCK_FILE, lockDataDir } from '../../lib/config/data-lock';
import { CLI, runCli } from '../cli-test-helpers';

const { version } = pkg;
const ENV = 'DOMAIN=eigen.example.org\n';

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A small install: .env.production, data/ with a nested file, and an empty snapshots/.
function install(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env.production'), ENV, { mode: 0o600 });
    mkdirSync(join(dir, 'data/home/alice'), { recursive: true });
    writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'original\n');
    mkdirSync(join(dir, 'snapshots'), { mode: 0o700 });
    return dir;
}

// macOS tar would add AppleDouble members for extended attributes.
const TAR_ENV = { COPYFILE_DISABLE: '1' };

// tar and friends, beside the CLI.
async function run(cmd: string[], cwd: string) {
    const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...TAR_ENV }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
}

const eigen = (cwd: string, ...args: string[]) => runCli(args, { cwd, env: TAR_ENV });

async function snapshot(dir: string, ...args: string[]): Promise<string> {
    const result = await eigen(dir, 'snapshot', ...args);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const name = /snapshots\/(\S+)/.exec(result.stdout)?.[1];
    if (!name) throw new Error(`no snapshot named in: ${result.stdout}`);
    expect(name).toMatch(SNAPSHOT_NAME);
    expect(existsSync(join(dir, 'snapshots', name))).toBe(true);
    return name;
}

// An archive in snapshots/ made by hand, for the refusals: everything staged, after what craft adds.
async function handMade(
    dir: string,
    name: string,
    meta: object | null,
    craft: (stage: string) => unknown = () => {},
): Promise<void> {
    const stage = mkdtempSync(join(tmpdir(), 'eigen-snapshot-stage-'));
    dirs.push(stage);
    if (meta) writeFileSync(join(stage, 'eigen-snapshot.json'), JSON.stringify(meta));
    writeFileSync(join(stage, '.env.production'), 'DOMAIN=other.example.org\n');
    mkdirSync(join(stage, 'data'));
    writeFileSync(join(stage, 'data/other.txt'), 'other\n');
    craft(stage);
    const tar = await run(['tar', '-czf', join(dir, 'snapshots', name), ...readdirSync(stage)], stage);
    expect(tar.code).toBe(0);
}

// A raw ustar entry, for what no tar run by an unprivileged user writes: a device, a hard link to outside.
function tarEntry(name: string, type: string, target = ''): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write('00000000000\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write(type, 156);
    header.write(target, 157);
    header.write('ustar\x0000', 257);
    header.write(
        `${header
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, '0')}\0 `,
        148,
    );
    return header;
}

function rawArchive(dir: string, name: string, entries: Buffer[]): void {
    const meta = Buffer.from(JSON.stringify({ version, createdAt: new Date().toISOString() }));
    const file = tarEntry('eigen-snapshot.json', '0');
    file.write(`${meta.length.toString(8).padStart(11, '0')}\0`, 124);
    file.write('        ', 148);
    file.write(
        `${file
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, '0')}\0 `,
        148,
    );
    const body = Buffer.alloc(512);
    meta.copy(body);
    const tar = Buffer.concat([
        file,
        body,
        tarEntry('.env.production', '0'),
        tarEntry('data/', '5'),
        ...entries,
        Buffer.alloc(1024),
    ]);
    writeFileSync(join(dir, 'snapshots', name), gzipSync(tar));
}

function untouched(dir: string): void {
    expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ENV);
    expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toEqual([]);
    expect(existsSync(join(dir, '.eigen/restore'))).toBe(false);
}

describe('snapshot', () => {
    test('writes snapshots/eigen-<UTC stamp>.tar.gz, mode 0600, stamped when it ran', async () => {
        const dir = install();
        const before = Math.floor(Date.now() / 1000) * 1000;
        const name = await snapshot(dir);
        const after = Date.now();
        const groups = SNAPSHOT_NAME.exec(name)?.groups;
        expect(groups?.['preUpdate']).toBeUndefined();
        const at = (groups && parseBackupStamp(groups)?.getTime()) ?? 0;
        expect(at).toBeGreaterThanOrEqual(before);
        expect(at).toBeLessThanOrEqual(after);
        expect(statSync(join(dir, 'snapshots', name)).mode & 0o777).toBe(0o600);
        expect(readdirSync(join(dir, 'snapshots'))).toEqual([name]);
    });

    test('makes snapshots/ when there is none, readable by its owner only', async () => {
        const dir = install();
        rmSync(join(dir, 'snapshots'), { recursive: true });
        await snapshot(dir);
        expect(statSync(join(dir, 'snapshots')).mode & 0o777).toBe(0o700);
    });

    test('keeps a sparse file sparse', async () => {
        const dir = install();
        const truncate = await run(['truncate', '-s', '1G', 'data/home/alice/sparse.img'], dir);
        expect(truncate.code).toBe(0);
        const name = await snapshot(dir);
        // gzip alone packs a GiB of zeros into about 1 MB.
        expect(statSync(join(dir, 'snapshots', name)).size).toBeLessThan(64 * 1024);
        rmSync(join(dir, 'data/home/alice/sparse.img'));
        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(0);
        expect(statSync(join(dir, 'data/home/alice/sparse.img')).size).toBe(1024 ** 3);
    });

    test('holds eigen-snapshot.json, then .env.production, then data/', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const archive = join(dir, 'snapshots', name);
        const list = await run(['tar', '-tzf', archive], dir);
        expect(list.stdout.split('\n').filter(Boolean)).toEqual([
            'eigen-snapshot.json',
            '.env.production',
            'data/',
            'data/home/',
            'data/home/alice/',
            'data/home/alice/notes.txt',
        ]);
        const meta = JSON.parse((await run(['tar', '-xzOf', archive, 'eigen-snapshot.json'], dir)).stdout);
        expect(Object.keys(meta)).toEqual(['version', 'createdAt', 'kind']);
        expect(meta.version).toBe(version);
        expect(meta.kind).toBe('full');
        const groups = SNAPSHOT_NAME.exec(name)?.groups;
        expect(Math.floor(Date.parse(meta.createdAt) / 1000) * 1000).toBe(
            (groups && parseBackupStamp(groups)?.getTime()) ?? 0,
        );
    });

    test('--pre-update keeps the new archive and the one before, and never a manual one', async () => {
        const dir = install();
        const older = [
            'eigen-pre-update-20200101-000000.tar.gz',
            'eigen-pre-update-20210101-000000.tar.gz',
            'eigen-pre-update-20220101-000000.tar.gz',
        ];
        const manual = 'eigen-20190101-000000.tar.gz';
        for (const file of [...older, manual, 'notes.txt']) writeFileSync(join(dir, 'snapshots', file), 'x');
        const name = await snapshot(dir, '--pre-update');
        expect(SNAPSHOT_NAME.exec(name)?.groups?.['preUpdate']).toBe('pre-update-');
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(
            [manual, 'eigen-pre-update-20220101-000000.tar.gz', name, 'notes.txt'].sort(),
        );
    });

    test('--pre-update removes the older ones before it writes, so the disk never holds three', async () => {
        const dir = install();
        const kept = 'eigen-pre-update-20220101-000000.tar.gz';
        for (const file of ['eigen-pre-update-20210101-000000.tar.gz', kept]) {
            writeFileSync(join(dir, 'snapshots', file), 'x');
        }
        mkdirSync(join(dir, 'snapshots/.eigen-snapshot.partial'));
        const result = await eigen(dir, 'snapshot', '--pre-update');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Could not write the snapshot');
        expect(readdirSync(join(dir, 'snapshots'))).toEqual([kept]);
    });

    test('records the version of the image that makes it', async () => {
        const dir = install();
        const name = await snapshot(dir, '--pre-update');
        const meta = await run(['tar', '-xzOf', join(dir, 'snapshots', name), 'eigen-snapshot.json'], dir);
        expect(JSON.parse(meta.stdout).version).toBe(version);
    });

    test('--pre-update names the snapshot, its kind, the version and the commit in .eigen/last-update', async () => {
        const dir = install();
        const result = await runCli(['snapshot', '--pre-update', '--light'], {
            cwd: dir,
            env: { ...TAR_ENV, EIGEN_COMMIT: 'abc1234' },
        });
        expect(result.code).toBe(0);
        const name = /snapshots\/(\S+)/.exec(result.stdout)?.[1];
        expect(readFileSync(join(dir, '.eigen/last-update'), 'utf8')).toBe(
            `archive=${name}\nversion=${version}\ncommit=abc1234\nkind=light\n`,
        );
    });

    test('a manual snapshot keeps the newest three made the same way, and no pre-update one counts', async () => {
        const dir = install();
        const preUpdate = ['eigen-pre-update-20200101-000000.tar.gz', 'eigen-pre-update-20210101-000000.tar.gz'];
        const manual = ['eigen-20190101-000000.tar.gz', 'eigen-20200101-000000.tar.gz', 'eigen-20210101-000000.tar.gz'];
        for (const file of [...preUpdate, ...manual, 'notes.txt']) writeFileSync(join(dir, 'snapshots', file), 'x');
        const name = await snapshot(dir);
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(
            [...preUpdate, ...manual.slice(1), name, 'notes.txt'].sort(),
        );
        expect(existsSync(join(dir, '.eigen/last-update'))).toBe(false);
    });

    test('names a light snapshot eigen-light-<UTC stamp>, and a light pre-update one eigen-pre-update-light-', async () => {
        const dir = server();
        const light = await snapshot(dir, '--light');
        expect(light).toMatch(/^eigen-light-\d{8}-\d{6}\.tar\.gz$/);
        expect(SNAPSHOT_NAME.exec(light)?.groups?.['light']).toBe('light-');
        const preUpdate = await snapshot(dir, '--pre-update', '--light');
        expect(preUpdate).toMatch(/^eigen-pre-update-light-\d{8}-\d{6}\.tar\.gz$/);
        expect(SNAPSHOT_NAME.exec(preUpdate)?.groups?.['preUpdate']).toBe('pre-update-');
        const full = await snapshot(dir);
        expect(SNAPSHOT_NAME.exec(full)?.groups?.['light']).toBeUndefined();
    });

    test('a light snapshot keeps the newest three light ones, and deletes no full one', async () => {
        const dir = server();
        const full = ['eigen-20190101-000000.tar.gz', 'eigen-20200101-000000.tar.gz'];
        const light = [
            'eigen-light-20210101-000000.tar.gz',
            'eigen-light-20220101-000000.tar.gz',
            'eigen-light-20230101-000000.tar.gz',
        ];
        for (const file of [...full, ...light]) writeFileSync(join(dir, 'snapshots', file), 'x');
        const name = await snapshot(dir, '--light');
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual([...full, ...light.slice(1), name].sort());
        const newer = await snapshot(dir, '--keep', '1');
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual([...light.slice(1), name, newer].sort());
    });

    test('--pre-update keeps the new archive and the one before of its own kind', async () => {
        const dir = server();
        const full = ['eigen-pre-update-20200101-000000.tar.gz', 'eigen-pre-update-20210101-000000.tar.gz'];
        const light = [
            'eigen-pre-update-light-20190101-000000.tar.gz',
            'eigen-pre-update-light-20220101-000000.tar.gz',
        ];
        for (const file of [...full, ...light]) writeFileSync(join(dir, 'snapshots', file), 'x');
        const name = await snapshot(dir, '--pre-update', '--light');
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual([...full, light[1], name].sort());
    });

    test('--keep sets how many manual snapshots stay, and takes only a count', async () => {
        const dir = install();
        writeFileSync(join(dir, 'snapshots/eigen-20200101-000000.tar.gz'), 'x');
        const name = await snapshot(dir, '--keep', '1');
        expect(readdirSync(join(dir, 'snapshots'))).toEqual([name]);
        for (const keep of ['0', 'two', '1.5']) {
            const result = await eigen(dir, 'snapshot', '--keep', keep);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('--keep takes a number of snapshots');
        }
        expect(readdirSync(join(dir, 'snapshots'))).toEqual([name]);
    });

    test('a snapshot that fails deletes no older one', async () => {
        const dir = install();
        const older = ['eigen-20200101-000000.tar.gz', 'eigen-20210101-000000.tar.gz', 'eigen-20220101-000000.tar.gz'];
        for (const file of older) writeFileSync(join(dir, 'snapshots', file), 'x');
        mkdirSync(join(dir, 'snapshots/.eigen-snapshot.partial'));
        expect((await eigen(dir, 'snapshot')).code).toBe(1);
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(older);
    });
});

// Two homes' worth of what a server holds: databases beside a file tree in every mount, and mail beside its index.
function server(): string {
    const dir = install();
    const write = (path: string, text: string) => {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), text);
    };
    write('data/server/users3.db', 'users before\n');
    write('data/server/avatars/a.webp', 'avatar\n');
    write('data/dkim/eigen.example.org/mail.private', 'key\n');
    for (const home of ['data/home/alice', 'data/team/t1']) {
        write(`${home}/settings.json`, '{}\n');
        write(`${home}/eigen.calendar/calendar.db`, 'calendar before\n');
        write(`${home}/mounts/shared.db`, 'shared\n');
        write(`${home}/mounts/default/metadata.db`, 'metadata before\n');
        write(`${home}/mounts/default/data/report.pdf`, 'file before\n');
        write(`${home}/mounts/default/thumbs/report.webp`, 'thumb\n');
    }
    write('data/home/alice/eigen.mail/mail.db', 'index before\n');
    write('data/home/alice/eigen.mail/Maildir/cur/1.eml', 'message\n');
    return dir;
}

const members = async (dir: string, name: string) =>
    (await run(['tar', '-tzf', join(dir, 'snapshots', name)], dir)).stdout.split('\n').filter(Boolean);

describe('a light snapshot', () => {
    test('holds data/server, every database and settings file, and the config, but no file tree and no mail', async () => {
        const dir = server();
        const name = await snapshot(dir, '--light');
        const held = await members(dir, name);
        expect([held[0], ...held.slice(-2)]).toEqual(['data/', '.env.production', 'eigen-snapshot.json']);
        for (const path of [
            'data/server/users3.db',
            'data/server/avatars/a.webp',
            'data/dkim/eigen.example.org/mail.private',
            'data/home/alice/settings.json',
            'data/home/alice/eigen.calendar/calendar.db',
            'data/home/alice/eigen.mail/mail.db',
            'data/home/alice/mounts/shared.db',
            'data/home/alice/mounts/default/metadata.db',
            'data/team/t1/mounts/default/metadata.db',
        ]) {
            expect(held).toContain(path);
        }
        expect(held.filter((path) => /\/mounts\/default\/.+\/|Maildir/.test(path))).toEqual([]);
        const meta = JSON.parse(
            (await run(['tar', '-xzOf', join(dir, 'snapshots', name), 'eigen-snapshot.json'], dir)).stdout,
        );
        expect(meta.kind).toBe('light');
    });

    test('puts back the databases and config in place and leaves files and mail as they are', async () => {
        const dir = server();
        const name = await snapshot(dir, '--light');
        writeFileSync(join(dir, 'data/server/users3.db'), 'users after\n');
        writeFileSync(join(dir, 'data/home/alice/mounts/default/metadata.db'), 'metadata after\n');
        writeFileSync(join(dir, 'data/home/alice/mounts/default/metadata.db-wal'), 'wal after\n');
        writeFileSync(join(dir, 'data/home/alice/mounts/default/data/report.pdf'), 'file after\n');
        writeFileSync(join(dir, 'data/home/alice/mounts/default/data/new.pdf'), 'new file\n');
        writeFileSync(join(dir, 'data/home/alice/eigen.mail/Maildir/cur/2.eml'), 'new message\n');
        mkdirSync(join(dir, 'data/home/bob/mounts/default/data'), { recursive: true });
        writeFileSync(join(dir, 'data/home/bob/mounts/default/metadata.db'), 'bob\n');
        writeFileSync(join(dir, 'data/home/bob/mounts/default/data/bob.txt'), 'bob file\n');
        rmSync(join(dir, 'data/team/t1'), { recursive: true });
        writeFileSync(join(dir, '.env.production'), 'DOMAIN=changed.example.org\n');

        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
            `Restored ${name}, a light snapshot of Eigen ${version}: databases and config restored; files and mail kept as they are`,
        );
        const read = (path: string) => readFileSync(join(dir, path), 'utf8');
        expect(read('data/server/users3.db')).toBe('users before\n');
        expect(read('data/home/alice/mounts/default/metadata.db')).toBe('metadata before\n');
        expect(read('.env.production')).toBe(ENV);
        expect(existsSync(join(dir, 'data/home/alice/mounts/default/metadata.db-wal'))).toBe(false);
        expect(read('data/home/alice/mounts/default/data/report.pdf')).toBe('file after\n');
        expect(read('data/home/alice/mounts/default/data/new.pdf')).toBe('new file\n');
        expect(read('data/home/alice/eigen.mail/Maildir/cur/2.eml')).toBe('new message\n');
        expect(read('data/home/bob/mounts/default/data/bob.txt')).toBe('bob file\n');
        expect(existsSync(join(dir, 'data/home/bob/mounts/default/metadata.db'))).toBe(false);
        expect(read('data/team/t1/mounts/default/metadata.db')).toBe('metadata before\n');
        expect(existsSync(join(dir, 'data/team/t1/mounts/default/data'))).toBe(false);

        const aside = readdirSync(dir).filter((file) => file.includes('pre-restore'));
        const dataAside = aside.find((file) => file.startsWith('data.'));
        expect(aside).toHaveLength(2);
        expect(result.stdout).toContain(`Kept aside: ${dataAside}`);
        const kept = (path: string) => readFileSync(join(dir, `${dataAside}`, path), 'utf8');
        expect(kept('server/users3.db')).toBe('users after\n');
        expect(kept('home/alice/mounts/default/metadata.db-wal')).toBe('wal after\n');
        expect(kept('home/bob/mounts/default/metadata.db')).toBe('bob\n');
        expect(existsSync(join(dir, `${dataAside}`, 'home/alice/mounts/default/data'))).toBe(false);
    });

    test('asks about the databases and config only, naming the kind', async () => {
        const dir = server();
        const name = await snapshot(dir, '--light');
        const result = await runCli(['restore', name], { cwd: dir, env: TAR_ENV, input: 'n\n' });
        expect(result.code).toBe(3);
        expect(result.stdout).toContain(
            `Put back the databases and config of data/ and .env.production from ${name}, a light snapshot of Eigen ${version}, made on `,
        );
        expect(result.stdout).toContain('Files and mail stay as they are');
    });

    // The API can name a folder anything; what tar reads as a pattern would drop data/server or every member.
    test('holds every database whatever a folder is named, and a restore of it puts them back', async () => {
        const dir = server();
        for (const name of ['evil\nserver', '*', 'evil\n*']) {
            mkdirSync(join(dir, 'data/home/alice/mounts/default', name, 'data'), { recursive: true });
        }
        mkdirSync(join(dir, 'data/home/alice/odd\nserver'));
        writeFileSync(join(dir, 'data/home/alice/odd\nserver/own.db'), 'own before\n');
        const name = await snapshot(dir, '--light');
        writeFileSync(join(dir, 'data/server/users3.db'), 'users after\n');
        writeFileSync(join(dir, 'data/home/alice/mounts/default/metadata.db'), 'metadata after\n');
        writeFileSync(join(dir, 'data/home/alice/odd\nserver/own.db'), 'own after\n');

        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const read = (path: string) => readFileSync(join(dir, path), 'utf8');
        expect(read('data/server/users3.db')).toBe('users before\n');
        expect(read('data/home/alice/mounts/default/metadata.db')).toBe('metadata before\n');
        expect(read('data/home/alice/odd\nserver/own.db')).toBe('own before\n');
        expect(existsSync(join(dir, 'data/home/alice/mounts/default/evil\nserver/data'))).toBe(true);
    });

    test('is refused before anything moves where this install has a folder in place of one of its files', async () => {
        const dir = server();
        const name = await snapshot(dir, '--light');
        rmSync(join(dir, 'data/home/alice/settings.json'));
        mkdirSync(join(dir, 'data/home/alice/settings.json'));
        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${name} cannot be restored: data/home/alice/settings.json is a folder here`);
        expect(readFileSync(join(dir, 'data/server/users3.db'), 'utf8')).toBe('users before\n');
        expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toEqual([]);
    });
});

describe('snapshot --check', () => {
    test('prints the kind, full unless --light', async () => {
        const dir = server();
        expect((await eigen(dir, 'snapshot', '--check')).stdout).toBe('kind=full\n');
        expect((await eigen(dir, 'snapshot', '--check', '--light')).stdout).toBe('kind=light\n');
        expect(readdirSync(join(dir, 'snapshots'))).toEqual([]);
    });

    test('--from makes it full after all when a release since that version is breaking', async () => {
        const dir = server();
        expect((await eigen(dir, 'snapshot', '--check', '--light', '--from', version)).stdout).toBe('kind=light\n');
        expect((await eigen(dir, 'snapshot', '--check', '--light', '--from', '0.1.1')).stdout).toBe('kind=full\n');
        expect((await eigen(dir, 'snapshot', '--check', '--from', 'latest')).stderr).toContain(
            '--from takes a version',
        );
    });
});

describe('restore', () => {
    test('puts the snapshot back and keeps what it replaced aside', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'changed\n');
        writeFileSync(join(dir, 'data/home/alice/new.txt'), 'new\n');
        writeFileSync(join(dir, '.env.production'), 'DOMAIN=changed.example.org\n', { mode: 0o644 });

        const result = await eigen(dir, 'restore', `snapshots/${name}`, '--yes');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
        expect(existsSync(join(dir, 'data/home/alice/new.txt'))).toBe(false);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ENV);
        const env = statSync(join(dir, '.env.production'));
        expect(env.mode & 0o777).toBe(0o600);
        expect(env.uid).toBe(statSync(dir).uid);
        expect(existsSync(join(dir, 'eigen-snapshot.json'))).toBe(false);

        const aside = readdirSync(dir).filter((file) => file.includes('pre-restore'));
        const dataAside = aside.find((file) => /^data\.pre-restore-\d{8}-\d{6}$/.test(file));
        const envAside = aside.find((file) => /^\.env\.production\.pre-restore-\d{8}-\d{6}$/.test(file));
        expect(aside).toHaveLength(2);
        if (!dataAside || !envAside) throw new Error(`nothing kept aside: ${aside.join(', ')}`);
        expect(readFileSync(join(dir, dataAside, 'home/alice/notes.txt'), 'utf8')).toBe('changed\n');
        expect(readFileSync(join(dir, envAside), 'utf8')).toBe('DOMAIN=changed.example.org\n');
        expect(result.stdout).toContain(dataAside);
        expect(result.stdout).toContain(envAside);
    });

    test('leaves out the collab epoch of the snapshot, so a tab that loaded a document before reloads', async () => {
        const dir = install();
        mkdirSync(join(dir, 'data/server'));
        writeFileSync(join(dir, 'data/server', COLLAB_EPOCH_FILE), 'before');
        const name = await snapshot(dir);
        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(0);
        expect(existsSync(join(dir, 'data/server', COLLAB_EPOCH_FILE))).toBe(false);
        expect(existsSync(join(dir, 'data/home/alice/notes.txt'))).toBe(true);
    });

    // A release install runs the images its .env.production pins; a source install builds its own and pins none.
    test.each([
        ['a release install', 'a source install', `${ENV}EIGEN_VERSION=${version}\n`, ENV],
        ['a source install', 'a release install', ENV, `${ENV}EIGEN_VERSION=${version}\n`],
    ])('refuses a snapshot of %s on %s before anything changes', async (theirs, ours, before, now) => {
        const dir = install();
        writeFileSync(join(dir, '.env.production'), before);
        const name = await snapshot(dir);
        writeFileSync(join(dir, '.env.production'), now);
        const result = await eigen(dir, 'restore', name, '--check', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${name} is a snapshot of ${theirs}; this is ${ours}.`);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(now);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
        expect(existsSync(join(dir, '.eigen/restore'))).toBe(false);
    });

    test('takes a bare name too, and gives the env file the install folder owner when there was none', async () => {
        const dir = install();
        const name = await snapshot(dir);
        rmSync(join(dir, '.env.production'));
        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(0);
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ENV);
        expect(statSync(join(dir, '.env.production')).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toHaveLength(1);
    });

    test('refuses a snapshot of a newer Eigen and changes nothing', async () => {
        const dir = install();
        await handMade(dir, 'eigen-20300101-000000.tar.gz', {
            version: '999.0.0',
            createdAt: new Date().toISOString(),
        });
        const result = await eigen(dir, 'restore', 'eigen-20300101-000000.tar.gz', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('999.0.0');
        expect(result.stderr).toContain(version);
        expect(result.stderr).toContain('Update first, then restore');
        untouched(dir);
    });

    test('a snapshot that breaks off halfway is refused before anything changes', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/noise.bin'), randomBytes(256 * 1024));
        const whole = await snapshot(dir);
        const bytes = readFileSync(join(dir, 'snapshots', whole));
        writeFileSync(join(dir, 'snapshots', name), bytes.subarray(0, bytes.length / 2));
        rmSync(join(dir, 'data/home/alice/noise.bin'));

        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${name} cannot be restored`);
        untouched(dir);
        expect(existsSync(join(dir, 'data/home/alice/noise.bin'))).toBe(false);
    });

    test('an interrupt while it unpacks leaves the live data as it was', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'changed\n');
        // A tar that unpacks everything and then hangs, so the interrupt lands mid-extract every time.
        const bin = mkdtempSync(join(tmpdir(), 'eigen-snapshot-bin-'));
        dirs.push(bin);
        writeFileSync(
            join(bin, 'tar'),
            `#!/bin/sh\ncase " $* " in *" -xzpf "*) "${Bun.which('tar')}" "$@" && touch "${bin}/unpacked" && exec sleep 30 ;; esac\nexec "${Bun.which('tar')}" "$@"\n`,
            { mode: 0o755 },
        );
        const proc = Bun.spawn([process.execPath, CLI, 'restore', name, '--yes'], {
            cwd: dir,
            env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, NO_COLOR: '1' },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        while (!existsSync(join(bin, 'unpacked'))) await Bun.sleep(10);
        proc.kill('SIGINT');
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(code).toBe(130);
        expect(stdout).toContain('Cancelled. Nothing was changed.');
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('changed\n');
        expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ENV);
        expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toEqual([]);
        expect(existsSync(join(dir, '.eigen/restore'))).toBe(false);
    });

    test('unpacks only .env.production and data/', async () => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() }, (stage) =>
            writeFileSync(join(stage, 'docker-compose.yml'), 'planted\n'),
        );
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(0);
        expect(readFileSync(join(dir, 'data/other.txt'), 'utf8')).toBe('other\n');
        expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(false);
        expect(existsSync(join(dir, 'eigen-snapshot.json'))).toBe(false);
    });

    test.each([
        // chmod(1): Bun's chmodSync drops these bits on macOS.
        [
            'a setuid file',
            (stage: string) => {
                Bun.spawnSync(['chmod', '4755', join(stage, 'data/other.txt')]);
                expect(statSync(join(stage, 'data/other.txt')).mode & 0o4000).toBe(0o4000);
            },
            'data/other.txt is setuid or setgid',
        ],
        [
            'a link to an absolute path',
            (stage: string) => symlinkSync('/etc/passwd', join(stage, 'data/passwd')),
            'data/passwd is a link that leads out of data/',
        ],
        [
            'a link out of data/',
            (stage: string) => symlinkSync('../../../eigen', join(stage, 'data/eigen')),
            'data/eigen is a link that leads out of data/',
        ],
        [
            'a link that leaves data/ through another link',
            (stage: string) => {
                symlinkSync('.', join(stage, 'data/here'));
                symlinkSync('here/../.env.production', join(stage, 'data/env'));
            },
            'data/env is a link that leads out of data/',
        ],
        [
            'a link to nothing',
            (stage: string) => symlinkSync('missing', join(stage, 'data/later')),
            'data/later is a link that leads out of data/',
        ],
        [
            '.env.production as a link',
            (stage: string) => {
                rmSync(join(stage, '.env.production'));
                symlinkSync('data/other.txt', join(stage, '.env.production'));
            },
            '.env.production is not a plain file',
        ],
        [
            '.env.production hard-linked into data/',
            (stage: string) => linkSync(join(stage, '.env.production'), join(stage, 'data/env')),
            '.env.production is not a plain file',
        ],
    ])('refuses a snapshot holding %s and changes nothing', async (_, craft, reason) => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() }, craft);
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`eigen-20200101-000000.tar.gz cannot be restored: ${reason}.`);
        untouched(dir);
    });

    // The API can make one, and it holds no data: refusing it would refuse every later snapshot.
    test('a fifo is left out rather than refused', async () => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() }, (stage) =>
            Bun.spawnSync(['mkfifo', join(stage, 'data/pipe')]),
        );
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(readdirSync(join(dir, 'data'))).toEqual(['other.txt']);
    });

    // Dovecot's IMAP COPY hard-links a message, and a setgid install folder hands g+s down to every folder.
    test('a hard-linked message and a setgid folder are restored', async () => {
        const dir = install();
        await handMade(
            dir,
            'eigen-20200101-000000.tar.gz',
            { version, createdAt: new Date().toISOString() },
            (stage) => {
                mkdirSync(join(stage, 'data/mail/cur'), { recursive: true });
                mkdirSync(join(stage, 'data/mail/.Archive/cur'), { recursive: true });
                writeFileSync(join(stage, 'data/mail/cur/1.eml'), 'message\n');
                linkSync(join(stage, 'data/mail/cur/1.eml'), join(stage, 'data/mail/.Archive/cur/1.eml'));
                // A folder takes setgid on macOS only in an own group.
                Bun.spawnSync(['chgrp', String(process.getgid?.()), join(stage, 'data/mail')]);
                Bun.spawnSync(['chmod', '2755', join(stage, 'data/mail')]);
                expect(statSync(join(stage, 'data/mail')).mode & 0o2000).toBe(0o2000);
            },
        );
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(statSync(join(dir, 'data/mail/.Archive/cur/1.eml')).ino).toBe(
            statSync(join(dir, 'data/mail/cur/1.eml')).ino,
        );
    });

    test('refuses a data/ that is a link, and changes nothing', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const elsewhere = mkdtempSync(join(tmpdir(), 'eigen-snapshot-data-'));
        dirs.push(elsewhere);
        renameSync(join(dir, 'data'), join(elsewhere, 'data'));
        symlinkSync(join(elsewhere, 'data'), join(dir, 'data'));
        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Restore needs data/ as a folder inside the install folder.');
        expect(lstatSync(join(dir, 'data')).isSymbolicLink()).toBe(true);
        untouched(dir);
    });

    test('a link inside data/ is restored', async () => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() }, (stage) =>
            symlinkSync('other.txt', join(stage, 'data/alias')),
        );
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(0);
        expect(readFileSync(join(dir, 'data/alias'), 'utf8')).toBe('other\n');
    });

    // An unprivileged tar cannot make a device, and a hard link reaches only what tar unpacked into the staging
    // folder: tar itself fails.
    test.each([
        ['a device', [tarEntry('data/null', '3')]],
        ['a hard link to the launcher', [tarEntry('data/eigen', '1', 'eigen')]],
        ['a hard link out of the install folder', [tarEntry('data/passwd', '1', '/etc/passwd')]],
    ])('fails to unpack a snapshot holding %s and changes nothing', async (_, entries) => {
        const dir = install();
        rawArchive(dir, 'eigen-20200101-000000.tar.gz', entries);
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(
            /^■ {2}Unpacking failed: .+\n└ {2}Fix what it says, then run \.\/eigen restore again\.\n$/,
        );
        untouched(dir);
    });

    test.each([
        ['a garbled version', { version: 'garbage', createdAt: new Date().toISOString() }],
        ['a garbled date', { version, createdAt: 'yesterday' }],
        ['a kind of snapshot there is not', { version, createdAt: new Date().toISOString(), kind: 'half' }],
    ])('refuses a snapshot with %s as not an Eigen snapshot', async (_, meta) => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', meta);
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not an Eigen snapshot');
        expect(result.stderr).not.toContain('    at ');
        untouched(dir);
    });

    test('refuses an archive without eigen-snapshot.json', async () => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', null);
        const result = await eigen(dir, 'restore', 'eigen-20200101-000000.tar.gz', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not an Eigen snapshot');
        untouched(dir);
    });

    test.each([
        ['../eigen-20200101-000000.tar.gz'],
        ['/etc/passwd'],
        ['snapshots/../snapshots/eigen-20200101-000000.tar.gz'],
        ['snapshots/notes.txt'],
        ['eigen-20200101-000001.tar.gz'],
        [''],
    ])('refuses %p', async (archive) => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() });
        writeFileSync(join(dir, 'snapshots/notes.txt'), 'x');
        const result = await eigen(dir, 'restore', archive, '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('eigen-20200101-000000.tar.gz');
        untouched(dir);
    });

    test('without --yes and without a terminal it asks for --yes and changes nothing', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const result = await eigen(dir, 'restore', name);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('--yes');
        untouched(dir);
    });

    test('a no to the question changes nothing, says so and exits 3 for the launcher', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const result = await runCli(['restore', name], { cwd: dir, env: TAR_ENV, input: 'n\n' });
        expect(result.code).toBe(3);
        expect(result.stdout).toContain(`with ${name}, a full snapshot of Eigen ${version}, made on `);
        expect(result.stdout).toContain(', just now?');
        expect(result.stdout).toContain('kept aside as data.pre-restore-*');
        expect(result.stdout).toContain('Nothing was changed.');
        untouched(dir);
    });

    test('names the newest snapshots by their time, pre-update ones included', async () => {
        const dir = install();
        for (const file of ['eigen-pre-update-20200101-000000.tar.gz', 'eigen-20210101-000000.tar.gz']) {
            writeFileSync(join(dir, 'snapshots', file), 'x');
        }
        const result = await eigen(dir, 'restore', '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toBe(
            [
                '■  Name the snapshot to restore.',
                '└  Pick one of the newest: eigen-20210101-000000.tar.gz, eigen-pre-update-20200101-000000.tar.gz\n',
            ].join('\n'),
        );
    });

    test('--check unpacks and checks aside, and the next run only swaps that copy in', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'changed\n');
        const check = await eigen(dir, 'restore', name, '--check', '--yes');
        expect(check.code).toBe(0);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('changed\n');
        expect(readFileSync(join(dir, '.eigen/restore/data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
        // Marks the unpacked copy, so the swap must use it rather than unpack again.
        writeFileSync(join(dir, '.eigen/restore/data/home/alice/notes.txt'), 'checked\n');
        const swap = await eigen(dir, 'restore', name, '--yes');
        expect(swap.code).toBe(0);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('checked\n');
        expect(existsSync(join(dir, '.eigen/restore'))).toBe(false);
    });

    test('--checked prints the version and kind of the snapshot a --check run unpacked, and nothing else', async () => {
        const dir = install();
        const name = await snapshot(dir, '--light');
        const before = await eigen(dir, 'restore', name, '--checked');
        expect(before.code).toBe(1);
        expect(before.stderr).toContain(`${name} is not checked yet.`);
        expect((await eigen(dir, 'restore', name, '--check', '--yes')).code).toBe(0);
        const checked = await eigen(dir, 'restore', name, '--checked');
        expect(checked.stdout).toBe(`version=${version}\nkind=light\n`);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
    });

    test('the swap takes what the archive holds from the --check run instead of reading it again', async () => {
        const dir = install();
        const name = await snapshot(dir);
        expect((await eigen(dir, 'restore', name, '--check', '--yes')).code).toBe(0);
        // A second read of the archive would refuse it now.
        writeFileSync(join(dir, 'snapshots', name), 'damaged');
        const swap = await eigen(dir, 'restore', name, '--yes');
        expect(swap.stderr).toBe('');
        expect(swap.code).toBe(0);
        expect(swap.stdout).toContain(`Restored ${name}, a full snapshot of Eigen ${version}`);
    });

    test('while another process holds data/, a backup and a swap are refused, and a check goes ahead', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'changed\n');
        mkdirSync(join(dir, 'data/server'));
        const lock = lockDataDir(join(dir, 'data/server', DATA_LOCK_FILE));
        try {
            const backup = await eigen(dir, 'snapshot');
            expect(backup.code).toBe(1);
            expect(backup.stderr).toContain('data/ is in use by Eigen or by another backup or restore.');
            expect(readdirSync(join(dir, 'snapshots'))).toEqual([name]);
            expect((await eigen(dir, 'restore', name, '--check', '--yes')).code).toBe(0);
            const swap = await eigen(dir, 'restore', name, '--yes');
            expect(swap.code).toBe(1);
            expect(swap.stderr).toContain('run ./eigen restore again');
        } finally {
            lock?.close();
        }
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('changed\n');
        expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toEqual([]);
    });

    test('an unpacked copy of another snapshot is not swapped in', async () => {
        const dir = install();
        const first = await snapshot(dir);
        await Bun.sleep(1000);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'second\n');
        const second = await snapshot(dir);
        expect((await eigen(dir, 'restore', first, '--check', '--yes')).code).toBe(0);
        expect((await eigen(dir, 'restore', second, '--yes')).code).toBe(0);
        expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('second\n');
    });
});
