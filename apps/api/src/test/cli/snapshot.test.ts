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

const CLI = join(import.meta.dir, '../../cli/index.ts');
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

async function run(cmd: string[], cwd: string, input?: string, env: Record<string, string> = {}) {
    const proc = Bun.spawn(cmd, {
        cwd,
        // macOS tar would add AppleDouble members for extended attributes.
        env: { ...process.env, COPYFILE_DISABLE: '1', NO_COLOR: '1', ...env },
        stdin: input === undefined ? 'ignore' : new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

const eigen = (cwd: string, ...args: string[]) => run([process.execPath, CLI, ...args], cwd);

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
        expect(Object.keys(meta)).toEqual(['version', 'createdAt']);
        expect(meta.version).toBe(version);
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
        expect(readdirSync(join(dir, 'snapshots')).sort()).toEqual(['.eigen-snapshot.partial', kept]);
    });

    test('records the version of the image that makes it', async () => {
        const dir = install();
        const name = await snapshot(dir, '--pre-update');
        const meta = await run(['tar', '-xzOf', join(dir, 'snapshots', name), 'eigen-snapshot.json'], dir);
        expect(JSON.parse(meta.stdout).version).toBe(version);
    });

    test('--pre-update names the snapshot, the version and the commit in .eigen/last-update for a rollback', async () => {
        const dir = install();
        const result = await run([process.execPath, CLI, 'snapshot', '--pre-update'], dir, undefined, {
            EIGEN_COMMIT: 'abc1234',
        });
        expect(result.code).toBe(0);
        const name = /snapshots\/(\S+)/.exec(result.stdout)?.[1];
        expect(readFileSync(join(dir, '.eigen/last-update'), 'utf8')).toBe(`${name}\n${version}\nabc1234\n`);
    });

    test('a manual snapshot deletes nothing and leaves .eigen/last-update alone', async () => {
        const dir = install();
        const older = ['eigen-pre-update-20200101-000000.tar.gz', 'eigen-pre-update-20210101-000000.tar.gz'];
        for (const file of [...older, 'eigen-pre-update-20220101-000000.tar.gz']) {
            writeFileSync(join(dir, 'snapshots', file), 'x');
        }
        await snapshot(dir);
        expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(4);
        expect(existsSync(join(dir, '.eigen/last-update'))).toBe(false);
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
            'a fifo',
            (stage: string) => Bun.spawnSync(['mkfifo', join(stage, 'data/pipe')]),
            'data/pipe is a device, fifo or socket',
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
        const result = await run([process.execPath, CLI, 'restore', name], dir, 'n\n');
        expect(result.code).toBe(3);
        expect(result.stdout).toContain(`a snapshot of Eigen ${version}, made on `);
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
