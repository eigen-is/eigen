import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { htmlToPdf, isWeasyPrintAvailable, shebangPython } from '../../lib/export/weasyprint';

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

const HTML = '<!DOCTYPE html><html><body>x</body></html>';

// One macrotask: htmlToPdf has spawned WeasyPrint.
const rendering = () => new Promise((resolve) => setImmediate(resolve));

describe('shebangPython', () => {
    test.each([
        ['#!/usr/bin/python3\nimport sys', '/usr/bin/python3'],
        [
            '#!/opt/homebrew/Cellar/weasyprint/68.1/libexec/bin/python\r\n',
            '/opt/homebrew/Cellar/weasyprint/68.1/libexec/bin/python',
        ],
        ['#!/opt/weasyprint/bin/python3.13\n', '/opt/weasyprint/bin/python3.13'],
        ['#! /usr/bin/env python3\n', 'python3'],
        ['#!/usr/bin/env -S python3 -X utf8\n', 'python3'],
        ['#!/usr/bin/env -S PYTHONUTF8=1 python3.13\n', 'python3.13'],
    ])('%j names %s', (head, python) => {
        expect(shebangPython(head)).toBe(python);
    });

    test.each([
        // pip's launcher for a venv whose path is long or holds a space.
        `#!/bin/sh\n'''exec' "/srv/my venv/bin/python3" "$0" "$@"\n' '''\nimport sys`,
        '#!/usr/bin/env node\n',
        '#!/usr/bin/env -S\n',
        'import sys\n',
        '',
    ])('%j names no python', (head) => {
        expect(shebangPython(head)).toBeNull();
    });
});

// A fresh process, since the probe is cached, with only a stub on PATH: a `weasyprint` launcher whose shebang names a
// stub python. Not python3, which the probe would try next. Its `probe` answers the version probe and its `render` a
// render. `script` runs with htmlToPdf, HTML and `outcome` (a render's PDF text or its status and message) in scope, and
// what it writes to stdout comes back parsed.
async function runWithStubPython(probe: string, render: string, script: string) {
    const dir = mkdtempSync(join(tmpdir(), 'stub-weasyprint-'));
    const python = join(dir, 'python3.13');
    writeFileSync(python, `#!/bin/sh\nif [ "$2" = -c ]; then\n${probe}\nfi\n/bin/cat > /dev/null\n${render}\n`, {
        mode: 0o755,
    });
    writeFileSync(join(dir, 'weasyprint'), `#!${python}\n`, { mode: 0o755 });
    try {
        const module = JSON.stringify(Bun.resolveSync('../../lib/export/weasyprint', import.meta.dir));
        const proc = Bun.spawn(
            [
                process.execPath,
                '-e',
                `const { htmlToPdf } = await import(${module});
                const HTML = ${JSON.stringify(HTML)};
                const outcome = (render) => render.then(
                    (pdf) => ({ pdf: pdf.toString() }),
                    ({ status, message }) => ({ status, message }),
                );
                ${script}`,
            ],
            { env: { ...process.env, PATH: dir }, stdout: 'pipe', stderr: 'pipe' },
        );
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        return { result: JSON.parse(stdout), stderr, dir };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Each export's outcome, one after the other.
async function exportWithStubPython(probe: string, render: string, exports = 1) {
    const { result, stderr } = await runWithStubPython(
        probe,
        render,
        `const outcomes = [];
        for (let i = 0; i < ${exports}; i++) outcomes.push(await outcome(htmlToPdf(HTML)));
        process.stdout.write(JSON.stringify(outcomes));`,
    );
    return { outcomes: result, stderr };
}

describe('htmlToPdf with a stub WeasyPrint', () => {
    test('one older than 68 answers 501 naming what it found and the minimum', async () => {
        const { outcomes } = await exportWithStubPython('echo 62.3; exit 0', "printf '%%PDF-'");
        expect(outcomes).toEqual([
            { status: 501, message: expect.stringContaining('WeasyPrint 68 or later, not 62.3') },
        ]);
    });

    test('a crash answers a bare 500 and logs the traceback', async () => {
        const { outcomes, stderr } = await exportWithStubPython(
            'echo 70.0; exit 0',
            "echo 'Traceback (most recent call last):' >&2; exit 1",
        );
        expect(outcomes).toEqual([{ status: 500, message: 'PDF generation failed' }]);
        expect(stderr).toContain('Traceback');
    });

    test('a render that segfaults renders once more', async () => {
        const { outcomes, stderr } = await exportWithStubPython(
            'echo 70.0; exit 0',
            `if [ ! -e "$0.crashed" ]; then : > "$0.crashed"; kill -SEGV $$; fi\nprintf '%%PDF-'`,
        );
        expect(outcomes).toEqual([{ pdf: '%PDF-' }]);
        expect(stderr).toContain('SIGSEGV');
    });

    test('a render that segfaults twice answers a bare 500', async () => {
        const { outcomes } = await exportWithStubPython('echo 70.0; exit 0', 'kill -SEGV $$');
        expect(outcomes).toEqual([{ status: 500, message: 'PDF generation failed' }]);
    });

    test('a render that fails otherwise renders no more', async () => {
        const { outcomes } = await exportWithStubPython(
            'echo 70.0; exit 0',
            `if [ -e "$0.failed" ]; then printf '%%PDF-'; exit 0; fi\n: > "$0.failed"; exit 1`,
        );
        expect(outcomes).toEqual([{ status: 500, message: 'PDF generation failed' }]);
    });

    // `exec`, so the timeout kills the sleep itself and nothing holds the probe's stdout open.
    test('a probe that hangs answers 501 and the next export probes again', async () => {
        const { outcomes } = await exportWithStubPython(
            `if [ ! -e "$0.hung" ]; then : > "$0.hung"; exec /bin/sleep 30; fi\necho 70.0; exit 0`,
            "printf '%%PDF-'",
            2,
        );
        expect(outcomes).toEqual([
            { status: 501, message: expect.stringContaining('WeasyPrint 68 or later.') },
            { pdf: '%PDF-' },
        ]);
    }, 15_000);

    // A render holds GBs, as a transform child does, so one runs at a time: each stub render takes a lock dir and
    // reports whether another render held it.
    test('renders run one at a time', async () => {
        const { result } = await runWithStubPython(
            'echo 70.0; exit 0',
            `if /bin/mkdir "$0.lock" 2>/dev/null; then /bin/sleep 0.2; /bin/rmdir "$0.lock"; printf alone; else printf overlap; fi`,
            `const outcomes = await Promise.all(Array.from({ length: 4 }, () => outcome(htmlToPdf(HTML))));
            process.stdout.write(JSON.stringify(outcomes));`,
        );
        expect(result).toEqual(Array(4).fill({ pdf: 'alone' }));
    }, 15_000);

    // A waiting render holds its document and its connection, so past MAX_WAITING_RENDERS the export is the
    // runner's 503, as a full transform queue is.
    test('past the waiting renders an export answers 503 busy', async () => {
        const { result } = await runWithStubPython(
            'echo 70.0; exit 0',
            "/bin/sleep 0.2; printf '%%PDF-'",
            `const outcomes = await Promise.all(Array.from({ length: 6 }, () => outcome(htmlToPdf(HTML))));
            process.stdout.write(JSON.stringify(outcomes));`,
        );
        expect(result).toEqual([
            ...Array(5).fill({ pdf: '%PDF-' }),
            { status: 503, message: 'The server is busy, please try again in a moment' },
        ]);
    }, 15_000);

    // The aborted waiter leaves the queue at once, its HTML with it, and never spawns.
    test('a waiting export whose request aborts leaves the queue before the render ahead of it ends', async () => {
        const { result } = await runWithStubPython(
            'echo 70.0; exit 0',
            `echo $$ >> "$0.pids"; /bin/sleep 1; printf '%%PDF-'`,
            `const controller = new AbortController();
            const started = Date.now();
            const first = outcome(htmlToPdf(HTML));
            const second = htmlToPdf(HTML, 1, controller.signal).then(() => 'rendered', () => Date.now() - started);
            await Bun.sleep(100);
            controller.abort();
            const leftAfter = await second;
            await first;
            const { readFileSync } = await import('node:fs');
            const spawned = readFileSync(process.env.PATH + '/python3.13.pids', 'utf8').trim().split('\\n').length;
            process.stdout.write(JSON.stringify({ leftAfter, spawned }));`,
        );
        expect(result.spawned).toBe(1);
        expect(result.leftAfter).toBeLessThan(800);
    }, 15_000);

    // The stub execs the sleep, so its pid is the render's: an abort must leave no such process.
    test('an aborted export kills its render, and one still waiting never starts', async () => {
        const { result } = await runWithStubPython(
            'echo 70.0; exit 0',
            'echo $$ >> "$0.pids"; exec /bin/sleep 30',
            `const controller = new AbortController();
            const started = Date.now();
            const renders = [outcome(htmlToPdf(HTML, 1, controller.signal)), outcome(htmlToPdf(HTML, 1, controller.signal))];
            const { readFileSync, existsSync } = await import('node:fs');
            const pids = () => existsSync(process.env.PATH + '/python3.13.pids') ? readFileSync(process.env.PATH + '/python3.13.pids', 'utf8').trim().split('\\n').map(Number) : [];
            while (pids().length === 0) await Bun.sleep(20);
            controller.abort();
            const outcomes = await Promise.all(renders);
            const alive = pids().filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
            process.stdout.write(JSON.stringify({ ms: Date.now() - started, spawned: pids().length, alive, failed: outcomes.every((o) => !o.pdf) }));`,
        );
        expect(result).toMatchObject({ spawned: 1, alive: [], failed: true });
        expect(result.ms).toBeLessThan(5_000);
    }, 15_000);

    // The wrapper the transform child runs under: the OOM killer takes the render before the API, and a data limit.
    test.skipIf(process.platform !== 'linux')(
        'a render runs under the limits a transform child takes',
        async () => {
            const { outcomes } = await exportWithStubPython(
                'echo 70.0; exit 0',
                '/bin/cat /proc/self/oom_score_adj; /bin/grep -E "^Max (data size|core file size)" /proc/self/limits',
            );
            const [{ pdf }] = outcomes;
            expect(pdf).toStartWith('1000\n');
            expect(pdf).not.toMatch(/Max data size\s+unlimited/);
            expect(pdf).toMatch(/Max core file size\s+0\s/);
        },
        15_000,
    );
});

suite('htmlToPdf', () => {
    test('a render killed by the timeout is a 504, not a failed render', async () => {
        const spawn = spyOn(Bun, 'spawn');
        try {
            const pending = htmlToPdf(HTML);
            await rendering();
            // SIGTERM is what the spawn timeout sends.
            const spawned = spawn.mock.results.at(-1);
            if (spawned?.type === 'return') spawned.value.kill();
            await expect(pending).rejects.toMatchObject({ status: 504 });
        } finally {
            spawn.mockRestore();
        }
    });

    test('a render that finishes returns the PDF', async () => {
        const pdf = await htmlToPdf(HTML);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });

    // As after a Homebrew upgrade, which removes the Cellar path the launcher named.
    test('a cached interpreter that is gone is probed again', async () => {
        const spawn = spyOn(Bun, 'spawn').mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOENT: no such file or directory, posix_spawn'), { code: 'ENOENT' });
        });
        try {
            const pdf = await htmlToPdf(HTML);
            expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
            expect(spawn.mock.calls.slice(1).some(([cmd]) => cmd.includes('-c'))).toBe(true);
        } finally {
            spawn.mockRestore();
        }
    });

    // A spawn inherits the environment the process started with, and the probe is cached, so a fresh process.
    test('neither the probe nor the render loads a weasyprint.py on PYTHONPATH or in the cwd', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'planted-weasyprint-'));
        const marker = join(dir, 'ran');
        writeFileSync(join(dir, 'weasyprint.py'), `open(${JSON.stringify(marker)}, 'w').write('x')\n`);
        try {
            const module = JSON.stringify(Bun.resolveSync('../../lib/export/weasyprint', import.meta.dir));
            const proc = Bun.spawn(
                [
                    process.execPath,
                    '-e',
                    `const { htmlToPdf } = await import(${module}); process.stdout.write((await htmlToPdf(${JSON.stringify(HTML)})).subarray(0, 5));`,
                ],
                { cwd: dir, env: { ...process.env, PYTHONPATH: dir }, stdout: 'pipe', stderr: 'inherit' },
            );
            const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
            expect(existsSync(marker)).toBe(false);
            expect(exitCode).toBe(0);
            expect(stdout).toBe('%PDF-');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
