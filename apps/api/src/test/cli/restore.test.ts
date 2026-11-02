import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
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
import { basename, dirname, join, relative } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupLevel, ServerArchiveManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import pkg from '../../../../../package.json' with { type: 'json' };
import { CANNOT_OPEN, DECLINED } from '../../cli/install';
import { STAGE_LOCK } from '../../cli/restore-stage';
import { SWAP_LOCK, SWAP_MARKER } from '../../cli/restore-swap';
import {
    copyArchiveMember,
    createServerArchiveWriter,
    declaredUnpackBytes,
    ENTRY_ALLOWANCE_BYTES,
    extractArtifact,
    packFolder,
    readArtifactManifest,
    withUnpackSlack,
} from '../../lib/backup/archive';
import { ARCHIVE_MANIFEST_FILE, getBackupsDir, SERVER_ARCHIVE_SERVER_MEMBER } from '../../lib/backup/paths';
import { stageBytesNeeded } from '../../lib/backup/restore-server';
import { startServerBackup } from '../../lib/backup/server-job';
import { DATA_LEASE_FILE, LEASE_WAIT_MS, lockDataDir, writeLease } from '../../lib/config/data-lock';
import {
    GUEST_HOMES_DIR,
    homeDirUnder,
    ORG_HOMES_DIR,
    PATHS,
    SERVER_DATABASES,
    SERVER_RUNTIME_FILES,
} from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import type { RealShapeHome } from '../backup/backup-test-helpers';
import {
    expectRealShape,
    holdLock,
    readServerManifest,
    realShapeHome,
    removeServerRecords,
    waitForJob,
} from '../backup/backup-test-helpers';
import type { FaultStorage } from '../fault-storage-helpers';
import { createHomeFaultMount, registerFaultMount, unregisterFaultMount } from '../fault-storage-helpers';
import type { TestContext, TestUser } from '../setup';
import {
    assertJson,
    authedRequest,
    createTeam,
    createTestUser,
    driveUpload,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
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
const TLS_KEY = '-----BEGIN PRIVATE KEY-----\narchived tls\n-----END PRIVATE KEY-----\n';
const S3_MOUNT_ID = 'restore-cli-s3';
const ASIDE = /^data\.pre-restore-\d{8}-\d{6}$/;

const dirs: string[] = [];
// Every install holds a restored copy of the suite's data root, which a full run makes large: past the
// default deadline the hook fails, and the afterAll below never runs.
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, JOB_TIMEOUT_MS);

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

// `preamble` runs before cli/restore.ts loads, to spy on what the run cannot show from outside. `input` answers the
// questions, a line each.
async function restoreCli(dir: string, args: string[], { preamble = [], env = {}, input }: CliSeams = {}) {
    const script = [
        `import { parseArgs } from 'node:util';`,
        ...preamble,
        `const { RESTORE_OPTIONS, restore } = await import(${JSON.stringify(RESTORE_CLI)});`,
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
            ...env,
        },
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

type CliSeams = { preamble?: string[]; env?: Record<string, string>; input?: string };

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
    expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
    expect(asideDirs(dir)).toEqual([]);
}

async function backup(level: BackupLevel): Promise<string> {
    const started = await startServerBackup({ level, reason: 'manual' });
    const job = await waitForJob(started.id);
    expect(job.error).toBeUndefined();
    if (!job.artifact) throw new Error('the server job names no archive');
    return join(getBackupsDir(), job.artifact);
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
    const { members, manifest: original } = await readServerManifest(source);
    const target = join(work, basename(source));
    const writer = await createServerArchiveWriter(target);
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
    const { members, manifest } = await readServerManifest(archive);
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
    const { members } = await readServerManifest(archive);
    const work = scratch('restore-server-member-');
    await extractArtifact(members.find((member) => member.name === SERVER_ARCHIVE_SERVER_MEMBER)!, join(work, 'tree'));
    const [folder] = readdirSync(join(work, 'tree'));
    const root = join(work, 'tree', folder);
    const manifest = JSON.parse(readFileSync(join(root, ARCHIVE_MANIFEST_FILE), 'utf8'));
    for (const name of [SERVER_RUNTIME_FILES.epoch, SERVER_RUNTIME_FILES.homeEpochs]) {
        const body = `${name} of the archived server`;
        writeFileSync(join(root, 'server', name), body);
        const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
        manifest.entries.push({ path: `server/${name}`, bytes: body.length, sha256 });
    }
    writeFileSync(join(root, ARCHIVE_MANIFEST_FILE), JSON.stringify(manifest));
    await packFolder(root, join(work, SERVER_ARCHIVE_SERVER_MEMBER));
    return { [SERVER_ARCHIVE_SERVER_MEMBER]: join(work, SERVER_ARCHIVE_SERVER_MEMBER) };
}

// A home member of `archive` with `edit` run on its unpacked folder, and its manifest's entries hashed again.
async function editedMember(
    archive: string,
    ownerId: string,
    edit: (folder: string) => void,
): Promise<Record<string, string>> {
    const { members, manifest } = await readServerManifest(archive);
    const name = manifest.homes.find((home) => home.ownerId === ownerId)!.member!;
    const work = scratch('restore-edited-');
    await extractArtifact(members.find((member) => member.name === name)!, join(work, 'tree'));
    const [folder] = readdirSync(join(work, 'tree'));
    const root = join(work, 'tree', folder);
    edit(root);
    const inner = JSON.parse(readFileSync(join(root, ARCHIVE_MANIFEST_FILE), 'utf8'));
    for (const entry of inner.entries) {
        const body = readFileSync(join(root, entry.path));
        entry.bytes = body.length;
        entry.sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
    }
    writeFileSync(join(root, ARCHIVE_MANIFEST_FILE), JSON.stringify(inner));
    await packFolder(root, join(work, 'member.tar.zst'));
    return { [name]: join(work, 'member.tar.zst') };
}

// `archive` with one more pending row in the s3 mount, for a key whose bytes it does not hold.
async function withUnbackedPendingRow(archive: string): Promise<string> {
    const replace = await editedMember(archive, s3User.id, (folder) => {
        const db = new Database(join(folder, 'home/mounts', S3_MOUNT_ID, PATHS.DRIVE.METADATA_DB));
        try {
            db.run(
                "INSERT INTO pending_uploads (storageKey, stagingPath, enqueuedAt, nextAttemptAt) VALUES ('no-such-key', 'no-such-upload', 0, 0)",
            );
        } finally {
            db.close();
        }
    });
    return craft(archive, { replace });
}

// The s3 mount as it runs here: a metadata.db whose pending rows are `pending`, key to staged name, each staged.
// WAL and closed, as an idle home leaves it on Linux: no -wal or -shm beside it.
function liveS3Mount(dir: string, pending: Record<string, string>): void {
    const mount = join(homeDirOf(dir, s3User.id), 'mounts', S3_MOUNT_ID);
    mkdirSync(join(mount, PATHS.DRIVE.STAGING_DIR), { recursive: true });
    const metadata = join(mount, PATHS.DRIVE.METADATA_DB);
    const db = new Database(metadata);
    try {
        db.run('PRAGMA journal_mode = WAL');
        db.run('CREATE TABLE pending_uploads (storageKey TEXT PRIMARY KEY, stagingPath TEXT NOT NULL)');
        for (const [key, name] of Object.entries(pending)) {
            db.run('INSERT INTO pending_uploads VALUES (?, ?)', [key, name]);
            writeFileSync(join(mount, PATHS.DRIVE.STAGING_DIR, name), 'pending here');
        }
        db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${metadata}${suffix}`, { force: true });
}

function homeDirOf(dir: string, ownerId: string): string {
    return homeDirUnder(join(dir, 'data'), ownerId);
}

let ctx: TestContext;
let alice: TestUser;
let aliceMountId: string;
let trashedId: string;
let teamOwner: string;
let teamName: string;
let s3User: TestUser;
let s3Mount: Mount;
let s3Fault: FaultStorage;
let stagedUploadName: string;
let stagedUploadKey: string;
let fullArchive: string;
let fullS3Archive: string;
let realShape: RealShapeHome;

beforeAll(async () => {
    ctx = await getTestContext();
    alice = ctx.alice.user;
    for (const user of [ctx.alice.user, ctx.bob.user, ctx.charlie.user]) await getHome(user.id);
    teamName = `Restore CLI Team ${Date.now()}`;
    teamOwner = teamOwnerId(await createTeam(ctx, getServerConfig()!.orgId, teamName));
    await getHome(teamOwner);
    realShape = await realShapeHome();

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
    await s3Mount.uploadQueue?.drain({ flushNow: true });
    const key = await s3Mount.getStorageKey(pending);
    s3Fault.parkWrites = true;
    const queue = s3Mount.uploadQueue!;
    const stagingPath = queue.newStagingPath();
    await Bun.write(stagingPath, 'not in the bucket yet');
    queue.enqueueStaged(key, stagingPath, false);
    await s3Fault.waitForParked((write) => write.key === key);
    stagedUploadName = basename(stagingPath);
    stagedUploadKey = key;

    mkdirSync(join(TEST_DATA_DIR, 'dkim'), { recursive: true });
    writeFileSync(join(TEST_DATA_DIR, 'dkim/eigen.private'), DKIM_KEY);
    writeFileSync(join(TEST_DATA_DIR, 'dkim/eigen.txt'), 'eigen._domainkey IN TXT "v=DKIM1"\n');
    const envFile = join(TEST_DATA_DIR, 'archived.env');
    writeFileSync(envFile, ARCHIVED_ENV);
    process.env['EIGEN_ENV_FILE'] = envFile;

    // Out again once archived: the status tests read this folder as the mail server's certificate.
    const certs = join(TEST_DATA_DIR, 'certs');
    mkdirSync(certs, { recursive: true });
    writeFileSync(join(certs, 'cert.pem'), 'archived certificate');
    writeFileSync(join(certs, 'key.pem'), TLS_KEY);
    try {
        fullArchive = await backup('full');
        fullS3Archive = await backup('full-s3');
    } finally {
        rmSync(certs, { recursive: true, force: true });
    }
}, JOB_TIMEOUT_MS);

afterAll(async () => {
    delete process.env['EIGEN_ENV_FILE'];
    s3Fault.parkWrites = false;
    await s3Fault.landAllRemaining();
    unregisterFaultMount((await getHome(s3User.id)).drive, S3_MOUNT_ID);
    await s3Mount.closeAllDatabases();
    // The backups folder is the whole suite's: a later file lists its server archives.
    removeServerRecords();
});

describe('restore --stage and --swap', () => {
    test(
        'a Full archive onto an empty data dir brings back every home, the server databases, env, DKIM and TLS, and keeps the old data aside',
        async () => {
            const dir = install();
            const { manifest } = await readServerManifest(fullArchive);
            const out = await stageAndSwap(dir, basename(fullArchive));

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
            expect(readFileSync(join(dir, 'data/certs/key.pem'), 'utf8')).toBe(TLS_KEY);
            expect(readFileSync(join(dir, 'data/certs/cert.pem'), 'utf8')).toBe('archived certificate');

            // What it replaced is aside, whole, and nothing of the restore's own is left.
            const [aside] = asideDirs(dir);
            expect(readFileSync(join(dir, aside, 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            const envAside = readdirSync(dir).find((name) => name.startsWith('.env.production.pre-restore-'));
            expect(readFileSync(join(dir, envAside!), 'utf8')).toBe(RELEASE_ENV);
            // eigen's finish_swap greps 'Kept aside: ' to tell what this swap kept from what was there before it.
            expect(out.split('\n')).toContain(`◇  Kept aside: ${aside}, ${envAside}`);
            expect(existsSync(join(dir, 'data/.restoring'))).toBe(false);
            expect(existsSync(join(dir, aside, '.restoring'))).toBe(false);
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
            expect(statSync(join(dir, '.env.production')).mode & 0o777).toBe(0o600);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a home that stores files by name comes back with every renamed, trashed and versioned item',
        async () => {
            const dir = install();
            await stageAndSwap(dir, basename(fullArchive));
            expectRealShape(homeDirOf(dir, realShape.user.id), realShape);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'on a new machine, whose data/ is empty and whose .env.production is the archive’s, nothing is kept aside',
        async () => {
            const dir = scratch('restore-new-machine-');
            mkdirSync(join(dir, 'data'));
            mkdirSync(join(dir, '.eigen'));
            writeFileSync(join(dir, '.env.production'), ARCHIVED_ENV, { mode: 0o600 });
            const out = await stageAndSwap(dir, basename(fullArchive));
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(readdirSync(dir).filter((name) => name.includes('.pre-restore-'))).toEqual([]);
            expect(out).not.toContain('Kept aside');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'the stage names each part as it stages it, the server’s own before the homes',
        async () => {
            const { stdout } = await stage(install(), basename(fullArchive));
            expect(stdout).toContain("│  the server's own databases and settings\n│  home 1 of ");
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'the data epoch changes: no epoch file survives, so every open tab reloads',
        async () => {
            const withEpochs = await craft(fullArchive, { replace: await serverMemberWithEpochs(fullArchive) });
            for (const archive of [fullArchive, withEpochs]) {
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
        'the stage names the homes not in the archive and those in it with warnings',
        async () => {
            const dir = install();
            const failed = { ownerId: 'f'.repeat(32), kind: 'user' as const, name: 'Gone', failed: 'disk full' };
            const warned = await craft(fullArchive, {
                manifest: (m) => ({
                    ...m,
                    homes: [
                        ...m.homes.map((home) =>
                            home.ownerId === alice.id ? { ...home, warnings: ['mount x: a.png', 'mount y: b'] } : home,
                        ),
                        failed,
                    ],
                }),
            });
            const name = (await readServerManifest(fullArchive)).manifest.homes.find(
                (home) => home.ownerId === alice.id,
            )!.name;
            const staged = await stage(dir, warned);
            expect(staged.code).toBe(0);
            expect(staged.stdout).toContain(`; not in it: Gone (disk full); with warnings: ${name} (mount x: a.png)`);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a Light archive is refused by its name before anything is read',
        async () => {
            const dir = install();
            const light = join(scratch('restore-light-'), 'server-pre-update-light-20260930-020304.tar');
            copyFileSync(fullArchive, light);
            const result = await stage(dir, light);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
                'server-pre-update-light-20260930-020304.tar is a Light backup, which this version of Eigen no longer restores.',
            );
            expectUntouched(dir);
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

    // rewrittenMember writes the modes builds up to 0.4.1 packed: 0755 folders and 0644 files.
    test(
        "an older archive's 0644 files and 0755 folders stage for the API's user alone",
        async () => {
            const dir = install();
            const member = await rewrittenMember(fullArchive, alice.id, (entries) => entries);
            const crafted = await craft(fullArchive, { replace: { [member.name]: member.file } });
            const result = await stage(dir, crafted);
            expect(result.stderr).toBe('');
            expect(result.code).toBe(0);
            const home = join(dir, 'data/.restoring/data/home', alice.id);
            expect(statSync(home).mode & 0o7777).toBe(0o700);
            expect(statSync(join(home, 'mounts')).mode & 0o7777).toBe(0o700);
            expect(statSync(join(home, 'settings.json')).mode & 0o7777).toBe(0o600);
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
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
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
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
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
        'an archive without the TLS certificate keeps the current one',
        async () => {
            const dir = install();
            mkdirSync(join(dir, 'data/certs'));
            writeFileSync(join(dir, 'data/certs/cert.pem'), 'the certificate here');
            writeFileSync(join(dir, 'data/certs/key.pem'), 'the key here');
            const crafted = await craft(fullArchive, {
                drop: (name) => name.startsWith('certs/'),
                manifest: (m) => ({ ...m, certs: false }),
            });
            await stageAndSwap(dir, crafted);
            expect(readFileSync(join(dir, 'data/certs/cert.pem'), 'utf8')).toBe('the certificate here');
            expect(readFileSync(join(dir, 'data/certs/key.pem'), 'utf8')).toBe('the key here');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'with mail off, by the .env.production of the archive or, without one, of this install, the stage says nothing of DKIM or mail TLS',
        async () => {
            const mailOff = join(scratch('restore-mail-off-'), 'mail-off.env');
            writeFileSync(mailOff, `${ARCHIVED_ENV}MAIL_ENABLED=0\n`);
            const noMail = { drop: (name: string) => name.startsWith('dkim/') || name.startsWith('certs/') };
            const fields = (m: Omit<ServerArchiveManifest, 'entries'>) => ({ ...m, dkim: false, certs: false });
            const ofMailOff = await craft(fullArchive, {
                ...noMail,
                replace: { '.env.production': mailOff },
                manifest: fields,
            });
            const withoutEnv = await craft(fullArchive, {
                drop: (name) => noMail.drop(name) || name === '.env.production',
                manifest: (m) => ({ ...fields(m), envFile: false }),
            });
            for (const [archive, env] of [
                [ofMailOff, RELEASE_ENV],
                [withoutEnv, `${RELEASE_ENV}MAIL_ENABLED=0\n`],
            ]) {
                const dir = install(env);
                const staged = await stage(dir, archive);
                expect(staged.code).toBe(0);
                expect(staged.stdout).toContain(`A full archive of Eigen ${pkg.version}`);
                expect(staged.stdout).not.toContain('DKIM');
                expect(staged.stdout).not.toContain('mail TLS');
            }
            const mailOn = await stage(install(), basename(fullArchive));
            expect(mailOn.stdout).toContain('The DKIM key from the archive');
            expect(mailOn.stdout).toContain('The mail TLS certificate from the archive');
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
        '--staged prints the staged version and the images its .env.production pins',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            const result = await restoreCli(dir, ['--staged']);
            expect(result.code).toBe(0);
            expect(result.stdout.trim().split('\n')).toEqual([
                `version=${pkg.version}`,
                'EIGEN_VERSION=0.3.1',
                'EIGEN_API_IMAGE=ghcr.io/eigen-is/eigen/api@sha256:abc',
            ]);
        },
        JOB_TIMEOUT_MS,
    );

    // The launcher runs --staged before it stops Eigen: a swap that cannot rename is refused there.
    test(
        '--staged refuses a data/ that is a link, or a staged tree on another disk, as the swap would',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            const elsewhere = await restoreCli(dir, ['--staged'], {
                preamble: [
                    `import { spyOn } from 'bun:test';`,
                    `import * as fs from 'node:fs';`,
                    'const lstat = fs.lstatSync;',
                    `spyOn(fs, 'lstatSync').mockImplementation((path, options) => { const stat = lstat(path, options); if (stat && String(path).startsWith('data/.restoring')) stat.dev += 1; return stat; });`,
                ],
            });
            expect(elsewhere.code).toBe(1);
            expect(elsewhere.stderr).toContain('is on another disk than data');
            renameSync(join(dir, 'data'), join(dir, 'data-real'));
            symlinkSync('data-real', join(dir, 'data'));
            const linked = await restoreCli(dir, ['--staged']);
            expect(linked.code).toBe(1);
            expect(linked.stderr).toContain('Restore needs data/ as a folder inside the install folder.');
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a Full swap is refused before its marker where data/.restoring sits on another disk',
        async () => {
            const dir = install();
            // Without .env.production, only data/ and the staged tree move: nothing else names that disk.
            const crafted = await craft(fullArchive, {
                drop: (name) => name === '.env.production',
                manifest: (m) => ({ ...m, envFile: false }),
            });
            expect((await stage(dir, crafted)).code).toBe(0);
            const result = await restoreCli(dir, ['--swap'], {
                preamble: [
                    `import { spyOn } from 'bun:test';`,
                    `import * as fs from 'node:fs';`,
                    'const lstat = fs.lstatSync;',
                    `spyOn(fs, 'lstatSync').mockImplementation((path, options) => { const stat = lstat(path, options); if (stat && String(path).startsWith('data/.restoring')) stat.dev += 1; return stat; });`,
                ],
            });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('another disk');
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
            expect(asideDirs(dir)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'an archive that calls itself full-s3 around full homes is refused before anything moves',
        async () => {
            const dir = install();
            const lying = await craft(fullArchive, { manifest: (m) => ({ ...m, level: 'full-s3' }) });
            const result = await stage(dir, lying);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('a full capture in a full-s3 archive');
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a trash that cannot be dated names its home',
        async () => {
            const dir = install();
            const replace = await editedMember(fullArchive, alice.id, (folder) => {
                for (const metadata of new Bun.Glob(`home/mounts/*/${PATHS.DRIVE.METADATA_DB}`).scanSync(folder)) {
                    const db = new Database(join(folder, metadata));
                    try {
                        db.run(
                            "CREATE TRIGGER no_redate BEFORE UPDATE OF trashedAt ON paths BEGIN SELECT RAISE(ABORT, 'no redate'); END",
                        );
                    } finally {
                        db.close();
                    }
                }
            });
            const result = await stage(dir, await craft(fullArchive, { replace }));
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(`the trash of ${alice.name} cannot be dated: no redate`);
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a stage the data disk has no room for is refused before anything is unpacked',
        async () => {
            const dir = install();
            const result = await restoreCli(dir, [basename(fullArchive), '--stage', '--yes'], {
                preamble: [
                    `import { spyOn } from 'bun:test';`,
                    `import * as fs from 'node:fs';`,
                    `spyOn(fs, 'statfsSync').mockImplementation(() => ({ bavail: 1, bsize: 4096 }));`,
                ],
            });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('4.00 KB free');
            expectUntouched(dir);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'the stage counts each member once at what its unpack declares, since it moves what it unpacks',
        async () => {
            const read = await readServerManifest(fullArchive);
            const { manifest } = read;
            const members = new Map(read.members.map((member) => [member.name, member]));
            const inner = [SERVER_ARCHIVE_SERVER_MEMBER, ...manifest.homes.flatMap((home) => home.member ?? [])];
            let declared = 0;
            let entries = 0;
            for (const name of inner) {
                const unpacked = await readArtifactManifest(members.get(name)!);
                declared += declaredUnpackBytes(unpacked);
                entries += unpacked.entries.length + (unpacked.counts.dirs ?? 0);
            }
            const copied = manifest.entries.filter((entry) => !inner.includes(entry.path));
            declared += copied.reduce((sum, entry) => sum + entry.bytes, 0);

            const needed = await stageBytesNeeded({ name: basename(fullArchive), manifest, members });
            expect(needed).toBe(withUnpackSlack(declared));
            // Every file and folder of a home takes its allowance, as each member's unpack charges it.
            expect(needed).toBeGreaterThan(entries * ENTRY_ALLOWANCE_BYTES);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a stage while another stages is refused and leaves its tree alone',
        async () => {
            const dir = install();
            mkdirSync(join(dir, 'data/.restoring/data'), { recursive: true });
            writeFileSync(join(dir, 'data/.restoring/data/half.txt'), 'the other stage');
            const other = lockDataDir(join(dir, 'data/.restoring', STAGE_LOCK))!;
            try {
                const result = await stage(dir, basename(fullArchive));
                expect(result.code).toBe(1);
                expect(result.stderr).toContain('Another restore is staging');
                expect(readFileSync(join(dir, 'data/.restoring/data/half.txt'), 'utf8')).toBe('the other stage');
            } finally {
                other.close();
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a second swap while one runs is refused before anything moves',
        async () => {
            const dir = install();
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            const other = lockDataDir(join(dir, SWAP_LOCK))!;
            try {
                const result = await swap(dir);
                expect(result.code).toBe(1);
                expect(result.stderr).toContain('Another restore is swapping');
                expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
                expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
                expect(asideDirs(dir)).toEqual([]);
            } finally {
                other.close();
            }
            expect((await swap(dir)).code).toBe(0);
        },
        JOB_TIMEOUT_MS,
    );

    // An API on another kernel, such as the Mac host beside the container, holds no file lock the swap can see. Each
    // swap waits LEASE_WAIT_MS on a foreign lease, so the two run side by side on installs of their own.
    test(
        'a swap with a live lease in data/server is refused before anything moves, and a stale one only delays it',
        async () => {
            const live = install();
            const stale = install();
            const staged = await Promise.all([live, stale].map((dir) => stage(dir, basename(fullArchive))));
            expect(staged.map((result) => result.code)).toEqual([0, 0]);
            const startedAt = new Date().toISOString();
            const heartbeat = (dir: string) =>
                writeLease(join(dir, 'data/server', DATA_LEASE_FILE), {
                    id: 'remote-id',
                    host: 'other-machine',
                    kernel: 'other-kernel',
                    dev: 0,
                    pid: 4242,
                    platform: 'darwin',
                    startedAt,
                    heartbeatAt: new Date().toISOString(),
                });
            heartbeat(live);
            heartbeat(stale);
            const remote = setInterval(() => heartbeat(live), 50);
            const timed = async (dir: string) => {
                const started = Date.now();
                const result = await swap(dir);
                return { result, waited: Date.now() - started };
            };
            try {
                const [{ result: refused }, { result: delayed, waited }] = await Promise.all([
                    timed(live),
                    // A stopped heartbeat leaves a lease that no longer moves, so it delays the swap once, not forever.
                    timed(stale),
                ]);
                expect(refused.code).toBe(1);
                expect(refused.stderr).toContain('other-machine');
                expect(refused.stderr).toContain('4242');
                expect(readFileSync(join(live, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
                expect(existsSync(join(live, SWAP_MARKER))).toBe(false);
                expect(asideDirs(live)).toEqual([]);
                expect(delayed.code).toBe(0);
                expect(waited).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
                // A refusal leaves the staged restore usable: once the remote API is gone, the same install swaps.
                clearInterval(remote);
                rmSync(join(live, 'data/server', DATA_LEASE_FILE));
                expect((await swap(live)).code).toBe(0);
            } finally {
                clearInterval(remote);
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'a swap clears backups/.staging, whose per-home restore notes describe the data/ that went aside',
        async () => {
            const dir = install();
            const note = join(dir, 'backups/.staging/job/restoring.json');
            mkdirSync(dirname(note), { recursive: true });
            writeFileSync(note, '{}');
            await stageAndSwap(dir, basename(fullArchive));
            expect(existsSync(join(dir, 'backups/.staging'))).toBe(false);
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

describe('restore --check-data, which a rollback runs first with the build it goes back to', () => {
    function bumpSchema(file: string, by: number): void {
        const db = new Database(file, { readwrite: true, create: false });
        try {
            db.run('UPDATE __schema_version SET version = version + ? WHERE id = 1', [by]);
        } finally {
            db.close();
        }
    }

    test(
        'passes on data this build opens, refuses a database of a newer schema in any kind of home or the server, or a damaged users3.db, as one it cannot open, and a database it may not read as no verdict',
        async () => {
            const dir = install();
            await stageAndSwap(dir, basename(fullArchive));
            const aside = asideDirs(dir);
            const passed = await restoreCli(dir, ['--check-data', '--yes']);
            expect(passed.stderr).toBe('');
            expect(passed.code).toBe(0);
            expect(passed.stdout).toContain('This build opens every database in data/');
            // One line per home, so a large server is not silent for minutes.
            const progress = passed.stdout.split('\n').filter((line) => / home \d+ of \d+: data\//.test(line));
            expect(progress.length).toBeGreaterThan(1);
            expect(progress.at(-1)).toContain(`home ${progress.length} of ${progress.length}: `);
            expect(passed.stdout).toContain(`: ${relative(dir, homeDirOf(dir, realShape.user.id))}\n`);
            // Without --yes it asks, and a no is the launcher's sign to change nothing.
            const declined = await restoreCli(dir, ['--check-data'], { input: 'n\n' });
            expect(declined.code).toBe(DECLINED);
            expect(declined.stdout).toContain('keeping the data as it is?');

            for (const file of [
                join(homeDirOf(dir, realShape.user.id), 'mounts/default/metadata.db'),
                join(homeDirOf(dir, teamOwner), PATHS.DRIVE.SHARED_DB),
                join(dir, 'data/server', SERVER_DATABASES.shares),
            ]) {
                bumpSchema(file, 1);
                const refused = await restoreCli(dir, ['--check-data', '--yes']);
                expect(refused.code).toBe(CANNOT_OPEN);
                expect(refused.stderr).toContain(`${relative(dir, file)} is at`);
                expect(refused.stderr).toContain('newer than this server');
                bumpSchema(file, -1);
            }
            // An org's and a guest's home count as a user's does.
            for (const kind of [ORG_HOMES_DIR, GUEST_HOMES_DIR]) {
                const home = join(dir, 'data', kind, 'copy');
                cpSync(homeDirOf(dir, realShape.user.id), home, { recursive: true });
                bumpSchema(join(home, 'mounts/default/metadata.db'), 1);
                const refused = await restoreCli(dir, ['--check-data', '--yes']);
                expect(refused.code).toBe(CANNOT_OPEN);
                expect(refused.stderr).toContain(`data/${kind}/copy/mounts/default/metadata.db is at`);
                rmSync(home, { recursive: true });
            }
            // The folder a killed per-home restore staged beside the homes is no home, whatever it holds.
            const staged = join(dirname(homeDirOf(dir, realShape.user.id)), '.restore-killed');
            cpSync(homeDirOf(dir, realShape.user.id), staged, { recursive: true });
            bumpSchema(join(staged, 'mounts/default/metadata.db'), 1);
            expect((await restoreCli(dir, ['--check-data', '--yes'])).code).toBe(0);
            rmSync(staged, { recursive: true });
            // users3.db has no schema version, so a damaged one is what refuses.
            const users = join(dir, 'data/server', SERVER_DATABASES.users);
            const intact = readFileSync(users);
            writeFileSync(users, Buffer.alloc(intact.length, 'x'));
            const damaged = await restoreCli(dir, ['--check-data', '--yes']);
            expect(damaged.code).toBe(CANNOT_OPEN);
            expect(damaged.stderr).toContain(`${relative(dir, users)} is damaged`);
            // The launcher says what to do next, so the CLI does not.
            expect(damaged.stderr).not.toContain('└');
            writeFileSync(users, intact);
            // A database it may not read says nothing of the data, so the rollback must not take it for one this
            // build cannot open and put the backup back.
            for (const file of [users, join(homeDirOf(dir, realShape.user.id), 'mounts/default/metadata.db')]) {
                chmodSync(file, 0);
                const unread = await restoreCli(dir, ['--check-data', '--yes']);
                chmodSync(file, 0o644);
                expect(unread.code).toBe(1);
                expect(unread.stderr).not.toContain('damaged');
            }
            // Nothing it reads is staged or moved.
            expect(existsSync(join(dir, 'data/.restoring'))).toBe(false);
            expect(asideDirs(dir)).toEqual(aside);
        },
        JOB_TIMEOUT_MS,
    );

    test('waits out a sign-in that holds users3.db, rather than calling it damaged', async () => {
        const dir = install();
        const users = join(dir, 'data/server', SERVER_DATABASES.users);
        const db = new Database(users);
        db.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
        db.close();
        // Long enough to outlast the start of the subprocess, short of the five seconds a writer is waited out.
        const lock = await holdLock(users, 2000);
        const checked = await restoreCli(dir, ['--check-data', '--yes']);
        expect(checked.stderr).toBe('');
        expect(checked.code).toBe(0);
        expect(await lock.exited).toBe(0);
    });
});

describe('restore --env, the first step on a fresh machine', () => {
    function fresh(): string {
        return scratch('restore-fresh-');
    }

    test(
        "writes the archive's .env.production into an empty folder, mode 0600, and nothing else",
        async () => {
            const dir = fresh();
            const result = await restoreCli(dir, [fullArchive, '--env']);
            expect(result.stderr).toBe('');
            expect(result.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(statSync(join(dir, '.env.production')).mode & 0o777).toBe(0o600);
            expect(readdirSync(dir)).toEqual(['.env.production']);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'refuses a folder that has a .env.production, an archive without one, and one of a local build',
        async () => {
            const here = fresh();
            writeFileSync(join(here, '.env.production'), RELEASE_ENV);
            const kept = await restoreCli(here, [fullArchive, '--env']);
            expect(kept.code).toBe(1);
            expect(kept.stderr).toContain('This folder has a .env.production already.');
            expect(readFileSync(join(here, '.env.production'), 'utf8')).toBe(RELEASE_ENV);

            const without = await craft(fullArchive, {
                drop: (name) => name === '.env.production',
                manifest: (m) => ({ ...m, envFile: false }),
            });
            const local = join(scratch('restore-local-env-'), 'local.env');
            writeFileSync(local, 'DOMAIN=archived.example.org\n');
            const ofLocal = await craft(fullArchive, { replace: { '.env.production': local } });
            for (const [archive, message] of [
                [without, 'holds no .env.production'],
                [ofLocal, 'is an archive of a local build'],
            ]) {
                const dir = fresh();
                const result = await restoreCli(dir, [archive, '--env']);
                expect(result.code).toBe(1);
                expect(result.stderr).toContain(message);
                expect(readdirSync(dir)).toEqual([]);
            }
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'refuses a damaged archive before it writes anything',
        async () => {
            const dir = fresh();
            const cut = join(scratch('restore-cut-'), basename(fullArchive));
            writeFileSync(cut, readFileSync(fullArchive).subarray(0, 4096));
            const result = await restoreCli(dir, [cut, '--env']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('is not a whole Eigen server archive');
            expect(readdirSync(dir)).toEqual([]);
        },
        JOB_TIMEOUT_MS,
    );

    // A copy of the full archive with one byte of `member` changed, its size and the manifest as they were.
    async function damaged(member: string): Promise<string> {
        const { members } = await readServerManifest(fullArchive);
        const { offset } = members.find(({ name }) => name === member)!;
        const bytes = readFileSync(fullArchive);
        bytes[offset] ^= 0xff;
        const copy = join(scratch('restore-damaged-'), basename(fullArchive));
        writeFileSync(copy, bytes);
        return copy;
    }

    test(
        'checks the .env.production it takes against the manifest, and leaves the other members to the stage',
        async () => {
            const refused = fresh();
            const result = await restoreCli(refused, [await damaged('.env.production'), '--env']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('.env.production: sha256 does not match the manifest');
            expect(readdirSync(refused)).toEqual([]);

            const taken = fresh();
            const elsewhere = await restoreCli(taken, [await damaged(SERVER_ARCHIVE_SERVER_MEMBER), '--env']);
            expect(elsewhere.stderr).toBe('');
            expect(elsewhere.code).toBe(0);
            expect(readFileSync(join(taken, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
        },
        JOB_TIMEOUT_MS,
    );
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
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(true);
            expect(existsSync(join(dir, '.env.production'))).toBe(false);

            const finished = await swap(dir);
            expect(finished.stderr).toBe('');
            expect(finished.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
            expect(readFileSync(join(dir, asideDirs(dir)[0], 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
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
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(true);

            const finished = await swap(dir);
            expect(finished.stderr).toBe('');
            expect(finished.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
            expect(readFileSync(join(dir, aside, 'home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
        },
        JOB_TIMEOUT_MS,
    );

    test(
        'one cut off before its marker goes, on a new machine, keeps data/ and .env.production in place',
        async () => {
            const dir = scratch('restore-new-machine-');
            mkdirSync(join(dir, 'data'));
            mkdirSync(join(dir, '.eigen'));
            writeFileSync(join(dir, '.env.production'), ARCHIVED_ENV, { mode: 0o600 });
            expect((await stage(dir, basename(fullArchive))).code).toBe(0);
            const broken = await restoreCli(dir, ['--swap'], {
                preamble: [
                    `import { spyOn } from 'bun:test';`,
                    `import * as fs from 'node:fs';`,
                    'const rm = fs.rmSync;',
                    `spyOn(fs, 'rmSync').mockImplementation((path, options) => { if (String(path) === ${JSON.stringify(SWAP_MARKER)}) process.exit(9); return rm(path, options); });`,
                ],
            });
            expect(broken.code).toBe(9);
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(true);

            const finished = await swap(dir);
            expect(finished.stderr).toBe('');
            expect(finished.code).toBe(0);
            expect(readFileSync(join(dir, '.env.production'), 'utf8')).toBe(ARCHIVED_ENV);
            expect(existsSync(join(homeDirOf(dir, alice.id), 'mounts'))).toBe(true);
            expect(readdirSync(dir).filter((name) => name.includes('.pre-restore-'))).toEqual([]);
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(false);
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
            expect(existsSync(join(dir, SWAP_MARKER))).toBe(true);
            expect(readFileSync(join(dir, 'data/home/old/notes.txt'), 'utf8')).toBe('kept aside\n');
        },
        JOB_TIMEOUT_MS,
    );

    test('a stage record cut off mid-write or of another shape reads as nothing staged, not a stack', async () => {
        const dir = install();
        mkdirSync(join(dir, 'data/.restoring'));
        for (const record of ['{"archive": "cut of', JSON.stringify({ archive: 'another-build', level: 'all' })]) {
            writeFileSync(join(dir, 'data/.restoring/staged.json'), record);
            for (const [flag, said] of [
                ['--swap', 'Nothing is staged to swap in'],
                ['--staged', 'Nothing is staged.'],
            ]) {
                const result = await restoreCli(dir, [flag]);
                expect(result.code).toBe(1);
                expect(result.stderr).toContain(said);
                expect(result.stderr).not.toContain('SyntaxError');
            }
        }
    });

    test('a marker that does not parse is refused with what to do, not a stack', async () => {
        const dir = install();
        writeFileSync(join(dir, SWAP_MARKER), '{"archive": "cut of');
        const result = await swap(dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('does not read as a swap');
        expect(result.stderr).not.toContain('SyntaxError');
    });

    test('a marker of another shape is refused with what to do, not a stack', async () => {
        const dir = install();
        for (const marker of [
            { archive: 'another-build', steps: [] },
            { archive: 'another-build', renames: [] },
        ]) {
            writeFileSync(join(dir, SWAP_MARKER), JSON.stringify(marker));
            const result = await swap(dir);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('does not read as a swap');
            expect(result.stderr).not.toContain('TypeError');
        }
    });
});

function stagedS3Mount(dir: string): string {
    return join(dir, 'data/.restoring/data/home', s3User.id, 'mounts', S3_MOUNT_ID);
}

// Each describe runs for both ways an archive carries a pending upload: in staging/, or among the files.
for (const [what, archive] of [
    ['staged uploads of an s3 mount', () => fullArchive],
    ['an archive with the files of an s3 mount, restored without them', () => fullS3Archive],
] as const) {
    describe(what, () => {
        test(
            'a pending upload the live mount has no row for any more is not replayed',
            async () => {
                const dir = install();
                liveS3Mount(dir, {});
                const result = await stage(dir, basename(archive()));
                expect(result.code).toBe(0);
                expect(result.stdout).toContain('1 pending upload');
                const staged = stagedS3Mount(dir);
                expect(existsSync(join(staged, PATHS.DRIVE.STAGING_DIR, stagedUploadName))).toBe(false);
                expect(existsSync(join(staged, PATHS.DRIVE.DATA_DIR))).toBe(false);
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a pending upload the live mount still has a row for, under any name, or a mount that never ran here, is replayed',
            async () => {
                for (const live of [{ [stagedUploadKey]: stagedUploadName }, { [stagedUploadKey]: 'newer' }, null]) {
                    const dir = install();
                    if (live) liveS3Mount(dir, live);
                    const result = await stage(dir, basename(archive()));
                    expect(result.code).toBe(0);
                    expect(result.stdout).not.toContain('pending upload');
                    const staged = stagedS3Mount(dir);
                    expect(readFileSync(join(staged, PATHS.DRIVE.STAGING_DIR, stagedUploadName), 'utf8')).toBe(
                        'not in the bucket yet',
                    );
                    expect(existsSync(join(staged, PATHS.DRIVE.DATA_DIR))).toBe(false);
                    const db = new Database(join(staged, PATHS.DRIVE.METADATA_DB), { readonly: true });
                    try {
                        expect(db.query('SELECT storageKey, stagingPath FROM pending_uploads').all()).toEqual([
                            { storageKey: stagedUploadKey, stagingPath: stagedUploadName },
                        ]);
                    } finally {
                        db.close();
                    }
                }
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a live metadata.db that does not read replays every pending upload, and says so',
            async () => {
                const dir = install();
                liveS3Mount(dir, {});
                const live = join(homeDirOf(dir, s3User.id), 'mounts', S3_MOUNT_ID, PATHS.DRIVE.METADATA_DB);
                writeFileSync(live, 'A'.repeat(8192));
                const result = await stage(dir, basename(archive()));
                expect(result.code).toBe(0);
                expect(result.stderr).toContain('every pending upload in the archive is replayed');
                expect(readFileSync(join(stagedS3Mount(dir), PATHS.DRIVE.STAGING_DIR, stagedUploadName), 'utf8')).toBe(
                    'not in the bucket yet',
                );
            },
            JOB_TIMEOUT_MS,
        );

        test(
            'a pending row whose bytes the archive does not hold is counted as not replayed',
            async () => {
                const dir = install();
                const result = await stage(dir, await withUnbackedPendingRow(archive()));
                expect(result.stderr).toBe('');
                expect(result.code).toBe(0);
                expect(result.stdout).toContain('1 pending upload(s) are not replayed: the archive does not hold');
                const staged = stagedS3Mount(dir);
                expect(readFileSync(join(staged, PATHS.DRIVE.STAGING_DIR, stagedUploadName), 'utf8')).toBe(
                    'not in the bucket yet',
                );
            },
            JOB_TIMEOUT_MS,
        );
    });
}

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
