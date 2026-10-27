// `bun run check`: every gate CI runs and every workspace's tests, all started at once, with the API suite on
// several isolated workers and CI's 30 s test timeout, as CI runs it. Each step's output goes to a log of its own and
// is printed whole, under the step's name, when the step ends, so steps that run side by side never interleave. Every
// step runs to its end, so one run shows every failure; the summary names each failed step, and the exit code is 1
// when any failed. `bun run check` starts it with --no-env-file, so no step inherits the root .env files' settings.

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';

type Step = { name: string; cmd: string[]; cwd?: string };
type Result = Step & { ok: boolean; seconds: number };

// On a 10-core Apple Silicon Mac the API suite took 243 s on 8 workers, 290 s on 6, and 298 s on 10, where tests that
// wait on a transform child timed out.
const API_WORKERS = 8;

const GATES: Step[] = [
    { name: 'dedupe', cmd: ['bun', 'dedupe', '--check'] },
    { name: 'lint', cmd: ['bun', 'run', 'lint'] },
    { name: 'typecheck', cmd: ['bun', 'run', 'typecheck'] },
    { name: 'home imports', cmd: ['bun', 'scripts/check-home-imports.ts'] },
    { name: 'test layout', cmd: ['bun', 'scripts/check-test-layout.ts'] },
    { name: 'docs links', cmd: ['bun', 'scripts/check-docs-links.ts'] },
    { name: 'standards', cmd: ['bun', 'run', 'standards'] },
    { name: 'primitives', cmd: ['bun', 'run', 'primitives:check'] },
];

// Every workspace with a `test` script, as `bun --filter '*' test` finds them. The API suite takes the workers and
// the per-file timings CI uses, which start its slowest files first.
const suites: Step[] = [];
for await (const manifest of new Glob('{apps,packages}/*/package.json').scan('.')) {
    const workspace = manifest.replaceAll('\\', '/').replace('/package.json', '');
    const pkg = await Bun.file(manifest).json();
    if (!pkg.scripts?.test) continue;
    const api = workspace === 'apps/api';
    const cmd = ['bun', 'run', 'test', '--timeout=30000'];
    if (api) cmd.push(`--parallel=${API_WORKERS}`, '--timings=src/test/timings.json');
    suites.push({ name: `test ${workspace}`, cmd, cwd: workspace });
}
// The API suite is the longest step, so it starts first.
suites.sort((a, b) => Number(b.cwd === 'apps/api') - Number(a.cwd === 'apps/api') || a.name.localeCompare(b.name));

const logs = mkdtempSync(join(tmpdir(), 'eigen-check-'));
const started = performance.now();

async function run(step: Step, index: number): Promise<Result> {
    const log = join(logs, `${index}.log`);
    // One descriptor for both streams keeps stdout and stderr in the order the step wrote them.
    const fd = openSync(log, 'a');
    const begin = performance.now();
    const child = Bun.spawn(step.cmd, { cwd: step.cwd, stdin: 'ignore', stdout: fd, stderr: fd });
    const ok = (await child.exited) === 0;
    closeSync(fd);
    const seconds = (performance.now() - begin) / 1000;
    console.log(`\n── ${step.name}: ${ok ? 'ok' : 'FAILED'} in ${seconds.toFixed(1)} s ──\n`);
    process.stdout.write(readFileSync(log));
    return { ...step, ok, seconds };
}

const steps = [...suites, ...GATES];
const results = await Promise.all(steps.map(run));
rmSync(logs, { recursive: true, force: true });

console.log(`\n── check: ${((performance.now() - started) / 1000).toFixed(1)} s ──`);
for (const result of results) {
    console.log(`  ${result.ok ? 'ok    ' : 'FAILED'}  ${result.name} (${result.seconds.toFixed(1)} s)`);
}
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
    console.error(
        `\n${failed.length} of ${results.length} steps failed: ${failed.map((step) => step.name).join(', ')}`,
    );
    process.exit(1);
}
