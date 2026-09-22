import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_ROOT = join(import.meta.dir, `../../../../../data-test/test-instance-lock-${Date.now()}`);
const LOCK_MODULE = resolve(import.meta.dir, '../../lib/core/instance-lock.ts');

// What index.ts runs first, in a process of its own: the lock is per process, so only a second process can contend.
const HOLDER_SCRIPT = `
import { holdInstanceLock } from ${JSON.stringify(LOCK_MODULE)};
const lock = holdInstanceLock(process.env.DATA_ROOT);
console.log('held');
if (process.env.HOLD) setInterval(() => lock, 1000);
`;

function spawnHolder(hold: boolean) {
    return Bun.spawn([process.execPath, '-e', HOLDER_SCRIPT], {
        env: { ...process.env, DATA_ROOT, ...(hold ? { HOLD: '1' } : {}) },
        stdout: 'pipe',
        stderr: 'pipe',
    });
}

afterAll(() => rmSync(DATA_ROOT, { recursive: true, force: true }));

describe('instance lock', () => {
    test('a second process on the same data dir is refused until the first one dies', async () => {
        mkdirSync(DATA_ROOT, { recursive: true });
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
});
