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
// render; each export's outcome comes back.
async function exportWithStubPython(probe: string, render: string, exports = 1) {
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
                const outcomes = [];
                for (let i = 0; i < ${exports}; i++) {
                    outcomes.push(await htmlToPdf(${JSON.stringify(HTML)}).then(
                        (pdf) => ({ pdf: pdf.toString() }),
                        ({ status, message }) => ({ status, message }),
                    ));
                }
                process.stdout.write(JSON.stringify(outcomes));`,
            ],
            { env: { ...process.env, PATH: dir }, stdout: 'pipe', stderr: 'pipe' },
        );
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        return { outcomes: JSON.parse(stdout), stderr };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
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
