import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBackupStamp, SNAPSHOT_NAME } from '@workspace/lib/validation';

const CLI = join(import.meta.dir, '../../cli/index.ts');
const ROOT = join(import.meta.dir, '../../../../..');
const { version }: { version: string } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ENV = 'DOMAIN=eigen.example.org\n';

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A small install: .env.production, data/ with a nested file, and an empty backups/.
function install(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env.production'), ENV, { mode: 0o600 });
    mkdirSync(join(dir, 'data/home/alice'), { recursive: true });
    writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'original\n');
    mkdirSync(join(dir, 'backups'));
    return dir;
}

async function run(cmd: string[], cwd: string) {
    const proc = Bun.spawn(cmd, {
        cwd,
        // macOS tar would add AppleDouble members for extended attributes.
        env: { ...process.env, COPYFILE_DISABLE: '1', NO_COLOR: '1' },
        stdin: 'ignore',
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
    const name = /backups\/(\S+)/.exec(result.stdout)?.[1];
    if (!name) throw new Error(`no snapshot named in: ${result.stdout}`);
    expect(name).toMatch(SNAPSHOT_NAME);
    expect(existsSync(join(dir, 'backups', name))).toBe(true);
    return name;
}

// An archive in backups/ made by hand, with these members, for the refusals.
async function handMade(dir: string, name: string, meta: object | null): Promise<void> {
    const stage = mkdtempSync(join(tmpdir(), 'eigen-snapshot-stage-'));
    dirs.push(stage);
    writeFileSync(join(stage, '.env.production'), 'DOMAIN=other.example.org\n');
    mkdirSync(join(stage, 'data'));
    writeFileSync(join(stage, 'data/other.txt'), 'other\n');
    const members = ['.env.production', 'data'];
    if (meta) {
        writeFileSync(join(stage, 'eigen-snapshot.json'), JSON.stringify(meta));
        members.unshift('eigen-snapshot.json');
    }
    const tar = await run(['tar', '-czf', join(dir, 'backups', name), ...members], stage);
    expect(tar.code).toBe(0);
}

function untouched(dir: string): void {
    expect(readFileSync(join(dir, 'data/home/alice/notes.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ENV);
    expect(readdirSync(dir).filter((file) => file.includes('pre-restore'))).toEqual([]);
}

describe('snapshot', () => {
    test('writes backups/eigen-<UTC stamp>.tar.gz, mode 0600, stamped when it ran', async () => {
        const dir = install();
        const before = Math.floor(Date.now() / 1000) * 1000;
        const name = await snapshot(dir);
        const after = Date.now();
        const groups = SNAPSHOT_NAME.exec(name)?.groups;
        expect(groups?.['preUpdate']).toBeUndefined();
        const at = (groups && parseBackupStamp(groups)?.getTime()) ?? 0;
        expect(at).toBeGreaterThanOrEqual(before);
        expect(at).toBeLessThanOrEqual(after);
        expect(statSync(join(dir, 'backups', name)).mode & 0o777).toBe(0o600);
        expect(readdirSync(join(dir, 'backups'))).toEqual([name]);
    });

    test('holds eigen-snapshot.json, then .env.production, then data/', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const archive = join(dir, 'backups', name);
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
        for (const file of [...older, manual, 'notes.txt']) writeFileSync(join(dir, 'backups', file), 'x');
        const name = await snapshot(dir, '--pre-update');
        expect(SNAPSHOT_NAME.exec(name)?.groups?.['preUpdate']).toBe('pre-update-');
        expect(readdirSync(join(dir, 'backups')).sort()).toEqual(
            [manual, 'eigen-pre-update-20220101-000000.tar.gz', name, 'notes.txt'].sort(),
        );
    });

    test('a manual snapshot deletes nothing', async () => {
        const dir = install();
        const older = ['eigen-pre-update-20200101-000000.tar.gz', 'eigen-pre-update-20210101-000000.tar.gz'];
        for (const file of [...older, 'eigen-pre-update-20220101-000000.tar.gz']) {
            writeFileSync(join(dir, 'backups', file), 'x');
        }
        await snapshot(dir);
        expect(readdirSync(join(dir, 'backups'))).toHaveLength(4);
    });
});

describe('restore', () => {
    test('puts the snapshot back and keeps what it replaced aside', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/notes.txt'), 'changed\n');
        writeFileSync(join(dir, 'data/home/alice/new.txt'), 'new\n');
        writeFileSync(join(dir, '.env.production'), 'DOMAIN=changed.example.org\n', { mode: 0o644 });

        const result = await eigen(dir, 'restore', `backups/${name}`, '--yes');
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

    test('a snapshot that breaks off halfway puts the current data back', async () => {
        const dir = install();
        const name = await snapshot(dir);
        writeFileSync(join(dir, 'data/home/alice/noise.bin'), randomBytes(256 * 1024));
        const whole = await snapshot(dir);
        const bytes = readFileSync(join(dir, 'backups', whole));
        writeFileSync(join(dir, 'backups', name), bytes.subarray(0, bytes.length / 2));
        rmSync(join(dir, 'data/home/alice/noise.bin'));

        const result = await eigen(dir, 'restore', name, '--yes');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`Could not unpack ${name}`);
        untouched(dir);
        expect(existsSync(join(dir, 'data/home/alice/noise.bin'))).toBe(false);
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
        ['backups/../backups/eigen-20200101-000000.tar.gz'],
        ['backups/notes.txt'],
        ['eigen-20200101-000001.tar.gz'],
        [''],
    ])('refuses %p', async (archive) => {
        const dir = install();
        await handMade(dir, 'eigen-20200101-000000.tar.gz', { version, createdAt: new Date().toISOString() });
        writeFileSync(join(dir, 'backups/notes.txt'), 'x');
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

    test('--check checks the archive and changes nothing', async () => {
        const dir = install();
        const name = await snapshot(dir);
        const result = await eigen(dir, 'restore', name, '--check', '--yes');
        expect(result.code).toBe(0);
        untouched(dir);
    });
});
