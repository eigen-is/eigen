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

    // WeasyPrint fails the whole render on attr(… url), which the sanitizer refuses before any export gets here.
    test('a crash answers a bare 500 and logs the traceback', async () => {
        const log = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(
                htmlToPdf('<html><body><div title="x" style="background-image: attr(title url)">x</div></body></html>'),
            ).rejects.toMatchObject({ status: 500, message: 'PDF generation failed' });
            expect(String(log.mock.calls[0]?.[1])).toContain('Traceback');
        } finally {
            log.mockRestore();
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
