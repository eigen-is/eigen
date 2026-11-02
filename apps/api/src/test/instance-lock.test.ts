import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_LEASE_FILE, LEASE_WAIT_MS, leaseKernel, writeLease } from '../lib/config/data-lock';
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

// Every wait below is the real one: a foreign lease costs a boot LEASE_WAIT_MS, and a heartbeat comes every half of it.
const LEASE_TEST_TIMEOUT_MS = 2 * LEASE_WAIT_MS;

// Two holders on one machine share the kernel, so another machine is a lease written here with a kernel of its own.
function writeForeignLease(dataRoot: string, kernel = 'other-kernel') {
    mkdirSync(join(dataRoot, 'server'), { recursive: true });
    const now = new Date().toISOString();
    writeLease(join(dataRoot, 'server', DATA_LEASE_FILE), {
        id: 'remote-id',
        host: 'other-machine',
        kernel,
        pid: 4242,
        platform: 'linux',
        startedAt: now,
        heartbeatAt: now,
    });
}

function readLeaseJson(dataRoot: string) {
    return JSON.parse(readFileSync(join(dataRoot, 'server', DATA_LEASE_FILE), 'utf8'));
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

    test(
        'a live lease from another kernel refuses the boot, naming its host and pid',
        async () => {
            const dataRoot = join(DATA_ROOT, 'lease-live');
            writeForeignLease(dataRoot);
            const remote = setInterval(() => writeForeignLease(dataRoot), 50);
            try {
                const holder = spawnHolder(false, dataRoot);
                expect(await holder.exited).toBe(1);
                expect(await new Response(holder.stdout).text()).toBe('');
                const stderr = await new Response(holder.stderr).text();
                expect(stderr).toContain('other-machine');
                expect(stderr).toContain('4242');
                expect(stderr).toContain(resolve(dataRoot));
            } finally {
                clearInterval(remote);
            }
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    test(
        'a stale lease from another kernel is taken over after the wait',
        async () => {
            const dataRoot = join(DATA_ROOT, 'lease-stale');
            writeForeignLease(dataRoot);
            const started = Date.now();
            const holder = spawnHolder(false, dataRoot);
            expect(await holder.exited).toBe(0);
            expect(Date.now() - started).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
            const lease = readLeaseJson(dataRoot);
            expect(lease.kernel).toBe(leaseKernel());
            expect(lease.id).not.toBe('remote-id');
        },
        LEASE_TEST_TIMEOUT_MS,
    );

    test('a lease a crashed process on this kernel left is taken over at once', async () => {
        const dataRoot = join(DATA_ROOT, 'lease-crashed');
        writeForeignLease(dataRoot, leaseKernel());
        const started = Date.now();
        const holder = spawnHolder(false, dataRoot);
        expect(await holder.exited).toBe(0);
        expect(Date.now() - started).toBeLessThan(LEASE_WAIT_MS / 2);
        expect(readLeaseJson(dataRoot).id).not.toBe('remote-id');
    });

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
