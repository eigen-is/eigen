import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function spawnHolder(hold: boolean, dataRoot = DATA_ROOT) {
    return Bun.spawn([process.execPath, '-e', HOLDER_SCRIPT], {
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
    test(
        'a foreign lease that moves during the wait refuses the boot, even one that does not parse or stalls',
        async () => {
            const live = join(DATA_ROOT, 'lease-live');
            const garbled = join(DATA_ROOT, 'lease-garbled-live');
            const stalled = join(DATA_ROOT, 'lease-stalled');
            let beats = 0;
            const heartbeat = () => {
                writeForeignLease(live);
                writeGarbledLease(garbled, `not a lease ${beats++}`);
            };
            heartbeat();
            writeForeignLease(stalled);
            const remote = setInterval(heartbeat, 50);
            const stalledBeat = setTimeout(() => writeForeignLease(stalled), 3 * LEASE_HEARTBEAT_MS);
            try {
                const holders = [spawnHolder(false, live), spawnHolder(false, garbled), spawnHolder(false, stalled)];
                expect(await Promise.all(holders.map((holder) => holder.exited))).toEqual([1, 1, 1]);
                for (const holder of holders) expect(await new Response(holder.stdout).text()).toBe('');
                const [liveErr, garbledErr] = await Promise.all(
                    holders.map((holder) => new Response(holder.stderr).text()),
                );
                expect(liveErr).toContain('other-machine');
                expect(liveErr).toContain('4242');
                expect(liveErr).toContain(resolve(live));
                expect(garbledErr).toContain(resolve(garbled));
            } finally {
                clearInterval(remote);
                clearTimeout(stalledBeat);
            }
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    // WSL2 runs every distro on one kernel, and one distro's view of another's folder goes over 9p, which has its own
    // device number and need not carry the file lock. So a lease from this kernel on another file system is foreign.
    test(
        'a foreign lease that sits still is taken over after the wait, even one that does not parse',
        async () => {
            const otherKernel = join(DATA_ROOT, 'lease-stale');
            writeForeignLease(otherKernel);
            const otherDev = join(DATA_ROOT, 'lease-other-dev');
            const local = localScope(otherDev);
            writeForeignLease(otherDev, { kernel: local.kernel, dev: local.dev + 1 });
            const garbled = join(DATA_ROOT, 'lease-garbled-stale');
            writeGarbledLease(garbled, 'not a lease');
            const started = Date.now();
            const takeOver = async (dataRoot: string) => {
                const holder = spawnHolder(false, dataRoot);
                expect(await holder.exited).toBe(0);
                expect(Date.now() - started).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
                const lease = readLease(leaseFileOf(dataRoot));
                expect(lease).toMatchObject(localScope(dataRoot));
                expect(lease?.id).not.toBe('remote-id');
            };
            await Promise.all([takeOver(otherKernel), takeOver(otherDev), takeOver(garbled)]);
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

    // The swap of ./eigen restore reads the lease as root, so a symlink to a FIFO or a device must not hang or fill it.
    test(
        'a lease that is not a regular file is no lease',
        async () => {
            const dataRoot = join(DATA_ROOT, 'lease-fifo');
            mkdirSync(join(dataRoot, 'server'), { recursive: true });
            const fifo = join(dataRoot, 'fifo');
            rmSync(fifo, { force: true });
            expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
            rmSync(leaseFileOf(dataRoot), { force: true });
            symlinkSync(fifo, leaseFileOf(dataRoot));
            const holder = spawnHolder(false, dataRoot);
            // A read of the FIFO would block for good, so a holder that hangs is killed and fails the exit code.
            const hung = setTimeout(() => holder.kill('SIGKILL'), LEASE_WAIT_MS / 2);
            expect(await holder.exited).toBe(0);
            clearTimeout(hung);
            expect(readLease(leaseFileOf(dataRoot))).toMatchObject(localScope(dataRoot));
        },
        LEASE_TEST_TIMEOUT_MS,
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
