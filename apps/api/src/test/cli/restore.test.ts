import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupJob, BackupLevel, ServerArchiveManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { parseServerArchiveManifest } from '@workspace/lib/validation';
import pkg from '../../../../../package.json' with { type: 'json' };
import {
    type ArchiveMember,
    copyArchiveMember,
    createArchiveWriter,
    extractArtifact,
    packFolder,
    readArchiveMember,
    readArchiveMembers,
} from '../../lib/backup/archive';
import { getBackupJob } from '../../lib/backup/jobs';
import { getBackupsDir } from '../../lib/backup/paths';
import { startServerBackup } from '../../lib/backup/server-job';
import { SERVER_DATABASES, SERVER_RUNTIME_FILES } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { PATHS } from '../../lib/core/constants';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import {
    createHomeFaultMount,
    type FaultStorage,
    registerFaultMount,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    createTeam,
    createTestUser,
    driveUpload,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    type TestContext,
    type TestUser,
} from '../setup';

// ./eigen restore as the launcher runs it: `restore <archive> --stage` as uid 1000 while Eigen runs, on the data
// root the API uses, then `restore --swap` as root in the install folder with Eigen stopped. Both run here as
// subprocesses on a scratch install; the archives are real whole-server archives of this file's fixture.

const JOB_TIMEOUT_MS = 120_000;
const RESTORE_CLI = join(import.meta.dir, '../../cli/restore.ts');
const ARCHIVED_ENV =
    'DOMAIN=archived.example.org\nEIGEN_VERSION=0.3.1\nEIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:abc\n';
const RELEASE_ENV = 'DOMAIN=here.example.org\nEIGEN_VERSION=0.3.0\n';
const DKIM_KEY = '-----BEGIN PRIVATE KEY-----\narchived\n-----END PRIVATE KEY-----\n';
const S3_MOUNT_ID = 'restore-cli-s3';
const ASIDE = /^data\.pre-restore-\d{8}-\d{6}$/;

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
    const dir = mkdtempSync(join(TEST_DATA_DIR, prefix));
    dirs.push(dir);
    return dir;
}

// An install folder as the launcher leaves one: .env.production, data/ with something in it, .eigen/.
function install(env = RELEASE_ENV): string {
    const dir = scratch('restore-install-');
    writeFileSync(join(dir, '.env.production'), env, { mode: 0o600 });
    mkdirSync(join(dir, 'data/home/old'), { recursive: true });
    writeFileSync(join(dir, 'data/home/old/notes.txt'), 'kept aside\n');
    mkdirSync(join(dir, 'data/server'), { recursive: true });
    writeFileSync(join(dir, 'data/server', SERVER_RUNTIME_FILES.epoch), 'epoch-before');
    mkdirSync(join(dir, '.eigen'));
    return dir;
}

async function restoreCli(dir: string, args: string[]) {
    const script = [
        `import { parseArgs } from 'node:util';`,
        `import { RESTORE_OPTIONS, restore } from ${JSON.stringify(RESTORE_CLI)};`,
        'const { values, positionals } = parseArgs({ args: process.argv.slice(1), options: RESTORE_OPTIONS, allowPositionals: true });',
        'await restore(positionals[0], values);',
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '-e', script, '--', ...args], {
        cwd: dir,
        env: {
            PATH: process.env['PATH'],
            HOME: process.env['HOME'],
            NO_COLOR: '1',
            EIGEN_DATA_ROOT: join(dir, 'data'),
            EIGEN_ENV_FILE: join(dir, '.env.production'),
            EIGEN_BACKUPS_DIR: getBackupsDir(),
        },
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

async function stage(dir: string, archive: string, ...flags: string[]) {
    return restoreCli(dir, [archive, '--stage', '--yes', ...flags]);
}

async function swap(dir: string) {
    return restoreCli(dir, ['--swap']);
}

async function stageAndSwap(dir: string, archive: string): Promise<string> {
    const staged = await stage(dir, archive);
    expect(staged.stderr).toBe('');
    expect(staged.code).toBe(0);
    const swapped = await swap(dir);
    expect(swapped.stderr).toBe('');
    expect(swapped.code).toBe(0);
    return `${staged.stdout}${swapped.stdout}`;
}

function asideDirs(dir: string): string[] {
    return readdirSync(dir).filter((name) => ASIDE.test(name));
}

// What a refusal leaves: nothing staged, nothing moved, no marker.
function expectUntouched(dir: string): void {
    expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
    expect(existsSync(join(dir, 'data/.restoring'))).toBe(false);
    expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
    expect(asideDirs(dir)).toEqual([]);
}

async function waitForJob(id: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 2400; attempt++) {
        const job = getBackupJob(id);
        if (job && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

async function backup(level: BackupLevel): Promise<string> {
    const started = await startServerBackup({ level, reason: 'manual', keep: 7 });
    const job = await waitForJob(started.id);
    expect(job.error).toBeUndefined();
    if (!job.artifact) throw new Error('the server job names no archive');
    return join(getBackupsDir(), job.artifact);
}

async function readManifest(
    archivePath: string,
): Promise<{ members: ArchiveMember[]; manifest: ServerArchiveManifest }> {
    const members = await readArchiveMembers(archivePath);
    const manifest = parseServerArchiveManifest(new TextDecoder().decode(await readArchiveMember(members.at(-1)!)));
    if (!manifest) throw new Error(`${archivePath} carries no server manifest`);
    return { members, manifest };
}

// A copy of `source` with its members changed: `replace` swaps a member's bytes for a file, `drop` leaves one out,
// `extra` adds members, and `manifest` edits the manifest the copy closes with.
async function craft(
    source: string,
    {
        replace = {},
        drop = () => false,
        extra = [],
        manifest = (m) => m,
    }: {
        replace?: Record<string, string>;
        drop?: (name: string) => boolean;
        extra?: { name: string; file: string }[];
        manifest?: (m: Omit<ServerArchiveManifest, 'entries'>) => Omit<ServerArchiveManifest, 'entries'>;
    },
): Promise<string> {
    const work = scratch('restore-craft-');
    const { members, manifest: original } = await readManifest(source);
    const target = join(work, basename(source));
    const writer = await createArchiveWriter(target);
    try {
        for (const [index, member] of members.slice(0, -1).entries()) {
            if (drop(member.name)) continue;
            let file = replace[member.name];
            if (!file) {
                file = join(work, `member-${index}`);
                await copyArchiveMember(member, file);
            }
            await writer.appendFile(member.name, file);
        }
        for (const { name, file } of extra) await writer.appendFile(name, file);
        const { entries: _, ...fields } = original;
        await writer.finish(manifest(fields));
    } finally {
        await writer.abort();
    }
    return target;
}

// A raw tar: what packFolder never writes, a link, a device, a setuid mode, a path that climbs out.
function tarHeader(name: string, type: string, mode: number, size: number, link: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0);
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write(type, 156);
    header.write(link, 157);
    header.write('ustar\x0000', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return header;
}

function tarOf(entries: { name: string; type: string; mode?: number; body?: Uint8Array; link?: string }[]): Uint8Array {
    const blocks: Uint8Array[] = [];
    const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);
    for (const { name, type, mode = 0o644, body = new Uint8Array(0), link = '' } of entries) {
        // A name past 100 bytes rides in a GNU long-name entry in front of its own.
        const bytes = Buffer.from(`${name}\0`);
        if (bytes.length > 100)
            blocks.push(tarHeader('././@LongLink', 'L', 0o644, bytes.length, ''), bytes, padding(bytes.length));
        blocks.push(tarHeader(name, type, mode, body.length, link), body, padding(body.length));
    }
    blocks.push(new Uint8Array(1024));
    return Buffer.concat(blocks);
}

// A home member of `archive` rewritten through tarOf: every file and folder of the real one, as found on disk.
async function rewrittenMember(
    archive: string,
    ownerId: string,
    change: (entries: Parameters<typeof tarOf>[0]) => Parameters<typeof tarOf>[0],
): Promise<{ name: string; file: string }> {
    const { members, manifest } = await readManifest(archive);
    const name = manifest.homes.find((home) => home.ownerId === ownerId)!.member!;
    const work = scratch('restore-member-');
    await extractArtifact(members.find((member) => member.name === name)!, join(work, 'tree'));
    const entries: Parameters<typeof tarOf>[0] = [];
    for (const rel of new Bun.Glob('**/*').scanSync({ cwd: join(work, 'tree'), onlyFiles: false, dot: true })) {
        const abs = join(work, 'tree', rel);
        if (statSync(abs).isDirectory()) entries.push({ name: `${rel}/`, type: '5', mode: 0o755 });
        else entries.push({ name: rel, type: '0', body: readFileSync(abs) });
    }
    const file = join(work, 'member.tar.zst');
    writeFileSync(file, Bun.zstdCompressSync(tarOf(change(entries))));
    return { name, file };
}

// server.tar.zst of `archive` with the data epoch files in server/, listed in its manifest like any other file.
async function serverMemberWithEpochs(archive: string): Promise<Record<string, string>> {
    const { members } = await readManifest(archive);
    const work = scratch('restore-server-member-');
    await extractArtifact(members.find((member) => member.name === 'server.tar.zst')!, join(work, 'tree'));
    const [folder] = readdirSync(join(work, 'tree'));
    const root = join(work, 'tree', folder);
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    for (const name of [SERVER_RUNTIME_FILES.epoch, SERVER_RUNTIME_FILES.homeEpochs]) {
        const body = `${name} of the archived server`;
        writeFileSync(join(root, 'server', name), body);
        const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
        manifest.entries.push({ path: `server/${name}`, bytes: body.length, sha256 });
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    await packFolder(root, join(work, 'server.tar.zst'));
    return { 'server.tar.zst': join(work, 'server.tar.zst') };
}

function homeDirOf(dir: string, ownerId: string): string {
    const owner = parseOwnerId(ownerId);
    return join(dir, 'data', owner.type === 'team' ? 'team' : 'home', owner.id);
}

let ctx: TestContext;
let alice: TestUser;
let aliceMountId: string;
let trashedId: string;
let teamOwner: string;
let s3User: TestUser;
let s3Mount: Mount;
let s3Fault: FaultStorage;
let stagedUploadName: string;
let fullArchive: string;
let lightArchive: string;

beforeAll(async () => {
    ctx = await getTestContext();
    alice = ctx.alice.user;
    for (const user of [ctx.alice.user, ctx.bob.user, ctx.charlie.user]) await getHome(user.id);
    teamOwner = teamOwnerId(await createTeam(ctx, getServerConfig()!.orgId, `Restore CLI Team ${Date.now()}`));
    await getHome(teamOwner);

    const mounts = await assertJson<{ id: string }[]>(
        await authedRequest(alice.sessionToken, `/drive/${alice.id}/mounts`),
    );
    aliceMountId = mounts[0].id;
    const root = await assertJson<DrivePath>(
        await authedRequest(alice.sessionToken, `/drive/${alice.id}/${aliceMountId}/root`),
    );
    await driveUpload(alice.sessionToken, alice.id, aliceMountId, root.id, new File(['kept bytes'], 'kept.txt'));
    const trashed = await driveUpload<DrivePath>(
        alice.sessionToken,
        alice.id,
        aliceMountId,
        root.id,
        new File(['trashed bytes'], 'trashed.txt'),
    );
    trashedId = trashed.id;
    const deleted = await authedRequest(alice.sessionToken, `/drive/${alice.id}/${aliceMountId}/path/${trashedId}`, {
        method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    // Trashed long ago, so a purge at the next boot would take it: the restore has to start its clock over.
    const live = openMountMetadata(join((await getHome(alice.id)).homeDir, 'mounts', aliceMountId, 'metadata.db'));
    try {
        live.run('UPDATE paths SET trashedAt = 1000 WHERE id = ?', [trashedId]);
    } finally {
        live.close();
    }

    // The s3 home: one upload still waiting in staging/, its PUT parked, which a Full archive carries.
    s3User = await createTestUser(`restore-cli-s3-${Date.now()}@test.eigen.is`, 'testpassword123', 'Restore S3');
    const s3Home = await getHome(s3User.id);
    const backing = scratch('restore-s3-backing-');
    ({ mount: s3Mount, fault: s3Fault } = createHomeFaultMount(s3Home, S3_MOUNT_ID, backing));
    await s3Mount.init();
    registerFaultMount(s3Home.drive, s3Mount);
    const s3Root = (await s3Mount.getRootFolder())!.id;
    const bytes = new TextEncoder().encode('in the bucket');
    const pending = await s3Mount.createFile(s3Root, 'pending.txt', 'text/plain', bytes.byteLength, bytes);
    await s3Mount.drainPendingUploads({ flushNow: true });
    const key = await s3Mount.getStorageKey(pending);
    s3Fault.parkWrites = true;
    const queue = s3Mount.uploadQueue!;
    const stagingPath = queue.newStagingPath();
    await Bun.write(stagingPath, 'not in the bucket yet');
    queue.enqueueStaged(key, stagingPath, false);
    await s3Fault.waitForParked((write) => write.key === key);
    stagedUploadName = basename(stagingPath);

    mkdirSync(join(TEST_DATA_DIR, 'dkim'), { recursive: true });
    writeFileSync(join(TEST_DATA_DIR, 'dkim/eigen.private'), DKIM_KEY);
    writeFileSync(join(TEST_DATA_DIR, 'dkim/eigen.txt'), 'eigen._domainkey IN TXT "v=DKIM1"\n');
    const envFile = join(TEST_DATA_DIR, 'archived.env');
    writeFileSync(envFile, ARCHIVED_ENV);
    process.env['EIGEN_ENV_FILE'] = envFile;

    fullArchive = await backup('full');
    lightArchive = await backup('light');
}, JOB_TIMEOUT_MS);

afterAll(async () => {
    delete process.env['EIGEN_ENV_FILE'];
    s3Fault.parkWrites = false;
    await s3Fault.landAllRemaining();
    unregisterFaultMount((await getHome(s3User.id)).drive, S3_MOUNT_ID);
    await s3Mount.closeAllDatabases();
});

describe('restore --stage and --swap', () => {
    test(
        'a Full archive onto an empty data dir brings back every home, the server databases, env and DKIM, and keeps the old data aside',
        async () => {
            const dir = install();
            const { manifest } = await readManifest(fullArchive);
            await stageAndSwap(dir, basename(fullArchive));

            for (const home of manifest.homes.filter((h) => h.member)) {
                expect(existsSync(homeDirOf(dir, home.ownerId))).toBe(true);
            }
            const files = [...new Bun.Glob('mounts/**/*').scanSync({ cwd: homeDirOf(dir, alice.id) })];
            const bodies = files.map((file) => readFileSync(join(homeDirOf(dir, alice.id), file), 'utf8'));
            expect(bodies).toContain('kept bytes');
            expect(existsSync(join(homeDirOf(dir, teamOwner), 'mounts'))).toBe(true);

            const users = new Database(join(dir, 'data/server', SERVER_DATABASES.users), { readonly: true });
            try {
                expect(users.query('SELECT id FROM user WHERE id = ?').get(alice.id)).toEqual({ id: alice.id });
            } finally {
                users.close();
            }
            expect(existsSync(join(dir, 'data/server', SERVER_DATABASES.shares))).toBe(true);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(readFileSync(join(dir, 'data/dkim/eigen.private'), 'utf8')).toBe(DKIM_KEY);

            // What it replaced is aside, whole, and nothing of the restore's own is left.
            const [aside] = asideDirs(dir);
            expect(readFileSync(join(dir, aside, 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            const envAside = readdirSync(dir).find((name) => name.startsWith('.env.production.pre-restore-'));
            expect(readFileSync(join(dir, envAside!), 'utf8')).toBe(RELEASE_ENV);
            expect(existsSync(join(dir, 'data/.restoring'))).toBe(false);
            expect(existsSync(join(dir, aside, '.restoring'))).toBe(false);
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
            expect(statSync(join(dir, '.env.production')).mode & 0o777).toBe(0o600);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'the data epoch changes: no epoch file survives, so every open tab reloads',
        async () => {
            const withEpochs = await craft(fullArchive, { replace: await serverMemberWithEpochs(fullArchive) });
            for (const archive of [fullArchive, lightArchive, withEpochs]) {
                const dir = install();
                await stageAndSwap(dir, archive);
                for (const name of [SERVER_RUNTIME_FILES.epoch, SERVER_RUNTIME_FILES.homeEpochs]) {
                    expect(existsSync(join(dir, 'data/server', name))).toBe(false);
                }
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'the trash starts over: every trashed row is dated at the restore',
        async () => {
            const dir = install();
            const before = Math.floor(Date.now() / 1000);
            await stageAndSwap(dir, basename(fullArchive));
            const db = new Database(join(homeDirOf(dir, alice.id), 'mounts', aliceMountId, 'metadata.db'), {
                readonly: true,
            });
            try {
                const row = db
                    .query<{ trashedAt: number }, [string]>('SELECT trashedAt FROM paths WHERE id = ?')
                    .get(trashedId);
                expect(row!.trashedAt).toBeGreaterThanOrEqual(before);
            } finally {
                db.close();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a Light archive puts back the databases and leaves the files and mail here as they are',
        async () => {
            const dir = install();
            const live = homeDirOf(dir, alice.id);
            mkdirSync(join(live, 'mounts', aliceMountId, 'data'), { recursive: true });
            writeFileSync(join(live, 'mounts', aliceMountId, 'data/live.txt'), 'live file');
            writeFileSync(join(live, 'mounts', aliceMountId, 'metadata.db'), 'the live metadata');
            mkdirSync(join(live, PATHS.MAIL.ROOT, PATHS.MAIL.MAILDIR, 'cur'), { recursive: true });
            writeFileSync(join(live, PATHS.MAIL.ROOT, PATHS.MAIL.MAILDIR, 'cur/1.eml'), 'live mail');
            mkdirSync(join(live, 'mounts', aliceMountId, PATHS.DRIVE.STAGING_DIR), { recursive: true });
            writeFileSync(join(live, 'mounts', aliceMountId, PATHS.DRIVE.STAGING_DIR, 'upload'), 'staged here');

            const output = await stageAndSwap(dir, basename(lightArchive));
            expect(output).toMatch(/light/i);
            expect(output).toMatch(/files and mail/);

            expect(readFileSync(join(live, 'mounts', aliceMountId, 'data/live.txt'), 'utf8')).toBe('live file');
            expect(readFileSync(join(live, PATHS.MAIL.ROOT, PATHS.MAIL.MAILDIR, 'cur/1.eml'), 'utf8')).toBe(
                'live mail',
            );
            const db = new Database(join(live, 'mounts', aliceMountId, 'metadata.db'), { readonly: true });
            try {
                expect(db.query('SELECT id FROM paths WHERE id = ?').get(trashedId)).toEqual({ id: trashedId });
            } finally {
                db.close();
            }
            const [aside] = asideDirs(dir);
            const mountAside = join(dir, aside, 'home', alice.id, 'mounts', aliceMountId);
            expect(readFileSync(join(mountAside, 'metadata.db'), 'utf8')).toBe('the live metadata');
            // A staged upload stays for the rows that name it, and a copy goes aside for reconcile to sweep.
            const upload = join(PATHS.DRIVE.STAGING_DIR, 'upload');
            expect(readFileSync(join(live, 'mounts', aliceMountId, upload), 'utf8')).toBe('staged here');
            expect(readFileSync(join(mountAside, upload), 'utf8')).toBe('staged here');
            // The live server/ went aside whole, epoch and all; a home the archive does not hold stays put.
            expect(readFileSync(join(dir, aside, 'server', SERVER_RUNTIME_FILES.epoch), 'utf8')).toBe('epoch-before');
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, 'data/server', SERVER_DATABASES.users))).toBe(true);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a Light archive onto an empty install says which homes come back without files and mail',
        async () => {
            const dir = install();
            const { manifest } = await readManifest(lightArchive);
            const staged = await stage(dir, basename(lightArchive));
            expect(staged.code).toBe(0);
            const count = manifest.homes.filter((home) => home.member).length;
            expect(staged.stdout).toContain(`${count} homes come back without their files and mail`);
            await swap(dir);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts', aliceMountId, 'metadata.db'))).toBe(true);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an archive of a newer Eigen is refused before anything moves',
        async () => {
            const dir = install();
            const newer = await craft(fullArchive, { manifest: (m) => ({ ...m, appVersion: '99.0.0' }) });
            const result = await stage(dir, newer);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('99.0.0');
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an archive of a release install is refused on a local build',
        async () => {
            const dir = install('DOMAIN=here.example.org\n');
            const result = await stage(dir, fullArchive);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('a release install');
            expect(result.stderr).toContain('a local build');
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a member that climbs out of the archive is refused before anything moves',
        async () => {
            const dir = install();
            const evil = join(scratch('restore-evil-'), 'evil');
            writeFileSync(evil, 'evil');
            const crafted = await craft(fullArchive, { extra: [{ name: '../../escape', file: evil }] });
            const result = await stage(dir, crafted);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('escape');
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    for (const [what, entry] of [
        ['a link', { type: '2', link: '/etc' }],
        ['a hard link', { type: '1', link: 'etc/passwd' }],
        ['a device', { type: '3' }],
        ['a path that climbs out', { type: '0', climb: true }],
    ] as const) {
        test(
            `a home member holding ${what} is refused before anything moves`,
            async () => {
                const dir = install();
                const member = await rewrittenMember(fullArchive, alice.id, (entries) => [
                    ...entries,
                    {
                        name: 'climb' in entry ? `home-${alice.id}/../../outside` : `home-${alice.id}/home/evil`,
                        type: entry.type,
                        link: 'link' in entry ? entry.link : '',
                    },
                ]);
                const crafted = await craft(fullArchive, { replace: { [member.name]: member.file } });
                const result = await stage(dir, crafted);
                expect(result.code).toBe(1);
                expect(result.stderr).toContain('refusing');
                expectUntouched(dir);
            },
            JOB_TIMEOUT_MS,
        );
    }

    test(
        'a setuid mode is stripped',
        async () => {
            const dir = install();
            const member = await rewrittenMember(fullArchive, alice.id, (entries) =>
                entries.map((entry) => (entry.name.endsWith('settings.json') ? { ...entry, mode: 0o4755 } : entry)),
            );
            const crafted = await craft(fullArchive, { replace: { [member.name]: member.file } });
            const result = await stage(dir, crafted);
            expect(result.stderr).toBe('');
            expect(result.code).toBe(0);
            const settings = join(dir, 'data/.restoring/data/home', alice.id, 'settings.json');
            expect(statSync(settings).mode & 0o7000).toBe(0);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a link planted in the staged tree is refused by the swap before anything moves',
        async () => {
            const dir = install();
            const staged = await stage(dir, basename(fullArchive));
            expect(staged.code).toBe(0);
            symlinkSync('/etc', join(dir, 'data/.restoring/data/home', alice.id, 'evil'));
            const result = await swap(dir);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('evil');
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(RELEASE_ENV);
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
            expect(asideDirs(dir)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a setuid file in the staged tree is refused by the swap before anything moves',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            chmodSync(join(dir, 'data/.restoring/data/home', alice.id, 'settings.json'), 0o4755);
            const result = await swap(dir);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('setuid');
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
            expect(asideDirs(dir)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a fifo in the staged tree is dropped, not refused',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            expect(Bun.spawnSync(['mkfifo', join(dir, 'data/.restoring/data/home', alice.id, 'pipe')]).exitCode).toBe(
                0,
            );
            const result = await swap(dir);
            expect(result.code).toBe(0);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'pipe'))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an archive without .env.production keeps the current one',
        async () => {
            const dir = install();
            const crafted = await craft(fullArchive, {
                drop: (name) => name === '.env.production',
                manifest: (m) => ({ ...m, envFile: false }),
            });
            await stageAndSwap(dir, crafted);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(RELEASE_ENV);
            expect(readdirSync(dir).filter((name) => name.startsWith('.env.production.pre-restore-'))).toEqual([]);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an archive without the DKIM key keeps the current one',
        async () => {
            const dir = install();
            mkdirSync(join(dir, 'data/dkim'));
            writeFileSync(join(dir, 'data/dkim/eigen.private'), 'the key here');
            const crafted = await craft(fullArchive, {
                drop: (name) => name.startsWith('dkim/'),
                manifest: (m) => ({ ...m, dkim: false }),
            });
            await stageAndSwap(dir, crafted);
            expect(readFileSync(join(dir, 'data/dkim/eigen.private'), 'utf8')).toBe('the key here');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a Light archive is refused before anything moves where this install has a folder in place of its file',
        async () => {
            const dir = install();
            mkdirSync(join(homeDirOf(dir, alice.id), 'mounts', aliceMountId, 'metadata.db'), { recursive: true });
            expect((await stage(dir, basename(lightArchive))).code).toBe(0);
            const result = await swap(dir);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('metadata.db');
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(readFileSync(join(dir, 'data/server', SERVER_RUNTIME_FILES.epoch), 'utf8')).toBe('epoch-before');
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
            expect(asideDirs(dir)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a stale data/.restoring is wiped before the stage',
        async () => {
            const dir = install();
            mkdirSync(join(dir, 'data/.restoring/data/home/stale'), { recursive: true });
            writeFileSync(join(dir, 'data/.restoring/data/home/stale/left.txt'), 'from a run that died');
            await stageAndSwap(dir, basename(fullArchive));
            expect(existsSync(join(dir, 'data/home/stale'))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        '--staged prints the staged version, level and the images its .env.production pins',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            const result = await restoreCli(dir, ['--staged']);
            expect(result.code).toBe(0);
            expect(result.stdout.trim().split('\n')).toEqual([
                `version=${pkg.version}`,
                'level=full',
                'EIGEN_VERSION=0.3.1',
                'EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:abc',
            ]);
        },
        JOB_TIMEOUT_MS,
    );

    test('a swap is refused when nothing is staged', async () => {
        const dir = install();
        const result = await swap(dir);
        expect(result.code).toBe(1);
        expectUntouched(dir);
    });
});

describe('an interrupted swap', () => {
    test(
        'one that died after its first rename is finished by the next --swap',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            // The first rename moves the current .env.production aside; the second, out of data/.restoring, fails.
            chmodSync(join(dir, 'data/.restoring'), 0o500);
            const broken = await swap(dir);
            chmodSync(join(dir, 'data/.restoring'), 0o700);
            expect(broken.code).toBe(1);
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(true);
            expect(existsSync(join(dir, '.env.production'))).toBe(false);

            const finished = await swap(dir);
            expect(finished.stderr).toBe('');
            expect(finished.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
            expect(readFileSync(join(dir, asideDirs(dir)[0], 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'one cut off after its last rename finishes without moving anything back',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            // The last step takes the staged tree's leftovers away; a folder it cannot empty stops it there.
            mkdirSync(join(dir, 'data/.restoring/stuck'));
            writeFileSync(join(dir, 'data/.restoring/stuck/file'), '');
            chmodSync(join(dir, 'data/.restoring/stuck'), 0o500);
            const broken = await swap(dir);
            const [aside] = asideDirs(dir);
            chmodSync(join(dir, aside, '.restoring/stuck'), 0o700);
            expect(broken.code).not.toBe(0);
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(true);

            const finished = await swap(dir);
            expect(finished.stderr).toBe('');
            expect(finished.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
            expect(readFileSync(join(dir, aside, 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'one that cannot go on names the half-done state and keeps its marker',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            chmodSync(join(dir, 'data/.restoring'), 0o500);
            expect((await swap(dir)).code).toBe(1);
            chmodSync(join(dir, 'data/.restoring'), 0o700);
            rmSync(join(dir, 'data/.restoring/.env.production'));

            const result = await swap(dir);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('data/.restoring/.env.production');
            expect(existsSync(join(dir, '.eigen/restore-swap'))).toBe(true);
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
        },
        JOB_TIMEOUT_MS,
    );
});

describe('staged uploads of an s3 mount', () => {
    test(
        'one the live mount already dropped from staging/ is not replayed',
        async () => {
            const dir = install();
            const liveStaging = join(homeDirOf(dir, s3User.id), 'mounts', S3_MOUNT_ID, PATHS.DRIVE.STAGING_DIR);
            mkdirSync(liveStaging, { recursive: true });
            const result = await stage(dir, basename(fullArchive));
            expect(result.code).toBe(0);
            expect(result.stdout).toContain('1 pending upload');
            const staged = join(
                dir,
                'data/.restoring/data/home',
                s3User.id,
                'mounts',
                S3_MOUNT_ID,
                PATHS.DRIVE.STAGING_DIR,
            );
            expect(existsSync(join(staged, stagedUploadName))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'one the live mount still stages, or a mount that never ran here, is replayed',
        async () => {
            for (const keepLive of [true, false]) {
                const dir = install();
                if (keepLive) {
                    const liveStaging = join(homeDirOf(dir, s3User.id), 'mounts', S3_MOUNT_ID, PATHS.DRIVE.STAGING_DIR);
                    mkdirSync(liveStaging, { recursive: true });
                    writeFileSync(join(liveStaging, stagedUploadName), 'still pending');
                }
                const result = await stage(dir, basename(fullArchive));
                expect(result.code).toBe(0);
                expect(result.stdout).not.toContain('pending upload');
                const staged = join(
                    dir,
                    'data/.restoring/data/home',
                    s3User.id,
                    'mounts',
                    S3_MOUNT_ID,
                    PATHS.DRIVE.STAGING_DIR,
                );
                expect(readFileSync(join(staged, stagedUploadName), 'utf8')).toBe('not in the bucket yet');
            }
        },
        JOB_TIMEOUT_MS,
    );
});

test('importing cli/restore.ts opens nothing under the data root', async () => {
    const root = join(scratch('restore-import-'), 'data');
    const proc = Bun.spawn([process.execPath, '-e', `await import(${JSON.stringify(RESTORE_CLI)});`], {
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], EIGEN_DATA_ROOT: root },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(existsSync(root)).toBe(false);
});
