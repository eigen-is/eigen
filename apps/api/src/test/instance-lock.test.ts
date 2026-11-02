import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    DATA_LEASE_FILE,
    LEASE_HEARTBEAT_MS,
    LEASE_WAIT_MS,
    lockScope,
    readLease,
    writeLease,
} from '../lib/config/data-lock';
import { TEST_DATA_DIR } from './setup';

const DATA_ROOT = join(TEST_DATA_DIR, 'instance-lock');
const LOCK_MODULE = resolve(import.meta.dir, '../instance-lock.ts');

// What index.ts runs first, in a process of its own: the lock is per process, so only a second process can contend.
const HOLDER_SCRIPT = `
import ${JSON.stringify(LOCK_MODULE)};
console.log('held');
if (process.env.HOLD) setInterval(() => {}, 1000);
`;

// What the graceful shutdown does last, before process.exit, on a data/server it can no longer write.
const RELEASE_SCRIPT = `
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { releaseInstanceLease } from ${JSON.stringify(LOCK_MODULE)};
chmodSync(join(process.env.EIGEN_DATA_ROOT, 'server'), 0o500);
releaseInstanceLease();
console.log('released');
`;

function spawnHolder(hold: boolean, dataRoot = DATA_ROOT, script = HOLDER_SCRIPT) {
    return Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, EIGEN_DATA_ROOT: dataRoot, ...(hold ? { HOLD: '1' } : {}) },
        stdout: 'pipe',
        stderr: 'pipe',
    });
}

// Every wait below is the real one: a foreign lease costs a boot LEASE_WAIT_MS, and the scenarios that wait run side
// by side, so a test pays it once.
const LEASE_TEST_TIMEOUT_MS = 2 * LEASE_WAIT_MS;

// Two holders on one machine share the lock scope, so another machine is a lease written here with a scope of its own.
function writeForeignLease(dataRoot: string, scope = { kernel: 'other-kernel', dev: 0 }) {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    const now = new Date().toISOString();
    writeLease(leaseFileOf(dataRoot), {
        id: 'remote-id',
        host: 'other-machine',
        ...scope,
        pid: 4242,
        platform: 'linux',
        startedAt: now,
        heartbeatAt: now,
    });
}

function leaseFileOf(dataRoot: string) {
    return join(dataRoot, 'server', DATA_LEASE_FILE);
}

function writeGarbledLease(dataRoot: string, text: string) {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    writeFileSync(leaseFileOf(dataRoot), text);
}

// Root opens a file whatever its mode, so only another user meets a lease it may not read.
const asUser = process.getuid?.() !== 0;

// A lease nobody but its owner reads, written anew each time as a heartbeat writes one.
function writeUnreadableLease(dataRoot: string) {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    const temp = `${leaseFileOf(dataRoot)}.tmp`;
    writeFileSync(temp, 'a lease', { mode: 0 });
    renameSync(temp, leaseFileOf(dataRoot));
}

// A process that listens on a socket at the lease's path. It binds the name inside data/server, as a whole path can
// be longer than a socket's address takes.
async function listenAtLease(dataRoot: string) {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    const listener = Bun.spawn(
        [
            process.execPath,
            '-e',
            `require('node:net').createServer().listen(${JSON.stringify(DATA_LEASE_FILE)}, () => console.log('listening'));`,
        ],
        { cwd: join(dataRoot, 'server'), stdout: 'pipe' },
    );
    expect(new TextDecoder().decode((await listener.stdout.getReader().read()).value)).toBe('listening\n');
    return listener;
}

// The scope a holder on this machine writes, once the folder exists to stat.
function localScope(dataRoot: string) {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    return lockScope(leaseFileOf(dataRoot));
}

describe('instance lock', () => {
    test('a second process on the same data dir is refused until the first one dies', async () => {
        const first = spawnHolder(true);
        try {
            const reader = first.stdout.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe('held\n');

            const refused = spawnHolder(false);
            expect(await refused.exited).toBe(1);
            expect(await new Response(refused.stdout).text()).toBe('');
            expect(await new Response(refused.stderr).text()).toContain(resolve(DATA_ROOT));
        } finally {
            first.kill('SIGKILL');
        }
        await first.exited;

        const next = spawnHolder(false);
        expect(await next.exited).toBe(0);
        expect(await new Response(next.stdout).text()).toBe('held\n');
    });

    test(
        'a bundled build, as the release image runs, holds the lock after the garbage collector ran',
        async () => {
            const dataRoot = join(DATA_ROOT, 'bundled');
            const dir = mkdtempSync(join(TEST_DATA_DIR, 'instance-lock-build-'));
            try {
                // What the entry point and the server do with the module.
                const entry = join(dir, 'entry.ts');
                writeFileSync(
                    entry,
                    `import ${JSON.stringify(LOCK_MODULE)};
import { releaseInstanceLease } from ${JSON.stringify(LOCK_MODULE)};
process.on('SIGTERM', () => { releaseInstanceLease(); process.exit(0); });
for (let i = 0; i < 5; i++) { Bun.gc(true); await Bun.sleep(50); }
console.log('held');
setInterval(() => {}, 1000);
`,
                );
                const built = await Bun.build({
                    entrypoints: [entry],
                    outdir: join(dir, 'out'),
                    target: 'bun',
                    splitting: true,
                    minify: true,
                });
                expect(built.success).toBe(true);
                const holder = Bun.spawn([process.execPath, join(dir, 'out/entry.js')], {
                    env: { ...process.env, EIGEN_DATA_ROOT: dataRoot },
                    stdout: 'pipe',
                    stderr: 'pipe',
                });
                try {
                    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe('held\n');
                    const refused = spawnHolder(false, dataRoot);
                    expect(await refused.exited).toBe(1);
                } finally {
                    holder.kill('SIGKILL');
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    // Two APIs starting together both read the empty lock file (a SHARED lock) before either escalates.
    // BEGIN EXCLUSIVE needs every other SHARED lock gone, so both got SQLITE_BUSY and both exited;
    // BEGIN IMMEDIATE only needs the RESERVED lock, which exactly one of them gets. Staggered test spawns
    // rarely hit that window, so this holds the SHARED lock a racing peer would.
    test('a process that is only reading the lock file does not keep the lock from being taken', async () => {
        const dataRoot = join(DATA_ROOT, 'reader');
        mkdirSync(join(dataRoot, 'server'), { recursive: true });
        const reader = new Database(join(dataRoot, 'server/instance.lock'), { create: true });
        try {
            reader.run('BEGIN;');
            reader.query('SELECT count(*) FROM sqlite_master').get();
            const holder = spawnHolder(false, dataRoot);
            expect(await holder.exited).toBe(0);
            expect(await new Response(holder.stdout).text()).toBe('held\n');
        } finally {
            reader.close();
        }
    });

    test('two processes started at the same moment leave exactly one holder', async () => {
        const pairs = Array.from({ length: 16 }, async (_, i) => {
            const dataRoot = join(DATA_ROOT, `race-${i}`);
            const racers = [spawnHolder(true, dataRoot), spawnHolder(true, dataRoot)];
            try {
                const outcomes = await Promise.all(
                    racers.map(async (racer) => {
                        const line = await racer.stdout.getReader().read();
                        return line.done ? await racer.exited : 'held';
                    }),
                );
                return outcomes.sort();
            } finally {
                for (const racer of racers) racer.kill('SIGKILL');
            }
        });
        for (const outcome of await Promise.all(pairs)) expect(outcome).toEqual([1, 'held']);
    });

    // A holder's heartbeat stalls while a synchronous boot or VACUUM blocks its event loop, and it is still alive.
    // WSL2 runs every distro on one kernel, and one distro's view of another's folder goes over 9p, which has its own
    // device number and need not carry the file lock. So a lease from this kernel on another file system is foreign.
    test(
        'a foreign lease that moves during the wait refuses the boot, and one that sits still is taken over after it',
        async () => {
            const live = join(DATA_ROOT, 'lease-live');
            const garbledLive = join(DATA_ROOT, 'lease-garbled-live');
            const stalled = join(DATA_ROOT, 'lease-stalled');
            const otherKernel = join(DATA_ROOT, 'lease-stale');
            const otherDev = join(DATA_ROOT, 'lease-other-dev');
            const garbledStale = join(DATA_ROOT, 'lease-garbled-stale');
            // A lease that cannot be opened, such as another user's or a socket in its place, may be live too.
            const unreadableLive = join(DATA_ROOT, 'lease-unreadable-live');
            const unreadableStale = join(DATA_ROOT, 'lease-unreadable-stale');
            const socketStale = join(DATA_ROOT, 'lease-socket');
            let beats = 0;
            const heartbeat = () => {
                writeForeignLease(live);
                writeGarbledLease(garbledLive, `not a lease ${beats++}`);
                if (asUser) writeUnreadableLease(unreadableLive);
            };
            heartbeat();
            writeForeignLease(stalled);
            writeForeignLease(otherKernel);
            const local = localScope(otherDev);
            writeForeignLease(otherDev, { kernel: local.kernel, dev: local.dev + 1 });
            writeGarbledLease(garbledStale, 'not a lease');
            if (asUser) writeUnreadableLease(unreadableStale);
            const socket = await listenAtLease(socketStale);
            const remote = setInterval(heartbeat, 50);
            const stalledBeat = setTimeout(() => writeForeignLease(stalled), 3 * LEASE_HEARTBEAT_MS);
            const started = Date.now();
            const refuse = async (dataRoot: string) => {
                const holder = spawnHolder(false, dataRoot);
                expect(await holder.exited).toBe(1);
                expect(await new Response(holder.stdout).text()).toBe('');
                const stderr = await new Response(holder.stderr).text();
                expect(stderr).toContain(resolve(dataRoot));
                return stderr;
            };
            const takeOver = async (dataRoot: string) => {
                const holder = spawnHolder(false, dataRoot);
                expect(await holder.exited).toBe(0);
                expect(Date.now() - started).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
                const lease = readLease(leaseFileOf(dataRoot));
                expect(lease).toMatchObject(localScope(dataRoot));
                expect(lease?.id).not.toBe('remote-id');
            };
            try {
                const [liveErr, garbledErr] = await Promise.all([
                    refuse(live),
                    refuse(garbledLive),
                    refuse(stalled),
                    takeOver(otherKernel),
                    takeOver(otherDev),
                    takeOver(garbledStale),
                    takeOver(socketStale),
                    ...(asUser ? [refuse(unreadableLive), takeOver(unreadableStale)] : []),
                ]);
                expect(liveErr).toContain('other-machine');
                expect(liveErr).toContain('4242');
                expect(garbledErr).toContain('the lease does not parse');
            } finally {
                clearInterval(remote);
                clearTimeout(stalledBeat);
                socket.kill('SIGKILL');
            }
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    test('a lease a crashed process on this kernel left is taken over at once', async () => {
        const dataRoot = join(DATA_ROOT, 'lease-crashed');
        writeForeignLease(dataRoot, localScope(dataRoot));
        const started = Date.now();
        const holder = spawnHolder(false, dataRoot);
        expect(await holder.exited).toBe(0);
        expect(Date.now() - started).toBeLessThan(LEASE_WAIT_MS / 2);
        expect(readLease(leaseFileOf(dataRoot))?.id).not.toBe('remote-id');
    });

    // The swap of ./eigen restore reads the lease as root, so a FIFO, a device or a symlink in its place must not hang
    // it, fill it or send it to another file.
    test(
        'a lease that is not a regular file is no lease, and neither is a symlink to one that is',
        async () => {
            const plant = (name: string, make: (leaseFile: string, dataRoot: string) => void) => {
                const dataRoot = join(DATA_ROOT, name);
                rmSync(dataRoot, { recursive: true, force: true });
                mkdirSync(join(dataRoot, 'server'), { recursive: true });
                make(leaseFileOf(dataRoot), dataRoot);
                return dataRoot;
            };
            const mkfifo = (path: string) => expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
            const roots = [
                plant('lease-fifo', mkfifo),
                plant('lease-link-fifo', (leaseFile, dataRoot) => {
                    mkfifo(join(dataRoot, 'fifo'));
                    symlinkSync(join(dataRoot, 'fifo'), leaseFile);
                }),
                // A foreign lease read through the link would cost the boot the wait.
                plant('lease-link-file', (leaseFile, dataRoot) => {
                    const target = join(dataRoot, 'target');
                    writeForeignLease(target);
                    symlinkSync(leaseFileOf(target), leaseFile);
                }),
            ];
            const started = Date.now();
            const holders = roots.map((dataRoot) => spawnHolder(false, dataRoot));
            // A read of a FIFO blocks for good, so a holder that hangs is killed and fails the exit code.
            const hung = setTimeout(() => {
                for (const holder of holders) holder.kill('SIGKILL');
            }, LEASE_WAIT_MS / 2);
            try {
                expect(await Promise.all(holders.map((holder) => holder.exited))).toEqual([0, 0, 0]);
            } finally {
                clearTimeout(hung);
            }
            expect(Date.now() - started).toBeLessThan(LEASE_WAIT_MS / 2);
            for (const dataRoot of roots) expect(readLease(leaseFileOf(dataRoot))).toMatchObject(localScope(dataRoot));
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    // Root writes into a folder whatever its mode, so as root the removal cannot be made to fail this way.
    test.skipIf(process.getuid?.() === 0)(
        'a lease the shutdown cannot remove is logged, and the process still exits 0',
        async () => {
            const dataRoot = join(DATA_ROOT, 'lease-unremovable');
            const server = join(dataRoot, 'server');
            mkdirSync(server, { recursive: true });
            chmodSync(server, 0o700);
            try {
                const holder = spawnHolder(false, dataRoot, RELEASE_SCRIPT);
                const [code, stdout, stderr] = await Promise.all([
                    holder.exited,
                    new Response(holder.stdout).text(),
                    new Response(holder.stderr).text(),
                ]);
                expect(code).toBe(0);
                expect(stdout).toBe('released\n');
                expect(stderr).toContain('could not remove the data dir lease');
                expect(readLease(leaseFileOf(dataRoot))).not.toBeNull();
            } finally {
                chmodSync(server, 0o700);
            }
        },
    );

    test(
        'a heartbeat that finds another id exits',
        async () => {
            const dataRoot = join(DATA_ROOT, 'lease-taken');
            const holder = spawnHolder(true, dataRoot);
            try {
                const reader = holder.stdout.getReader();
                expect(new TextDecoder().decode((await reader.read()).value)).toBe('held\n');
                writeForeignLease(dataRoot);
                expect(await holder.exited).toBe(1);
                const stderr = await new Response(holder.stderr).text();
                expect(stderr).toContain('other-machine');
                expect(stderr).toContain('4242');
            } finally {
                holder.kill('SIGKILL');
            }
        },
        LEASE_TEST_TIMEOUT_MS,
    );
});
