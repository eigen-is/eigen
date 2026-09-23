import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseNotes } from '../../cli/update-check';

const CLI = join(import.meta.dir, '../../cli/index.ts');
const ROOT = join(import.meta.dir, '../../../../..');
const { version }: { version: string } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const CHANGELOG = `# Changelog

All notable user-visible changes to Eigen are documented in this file.

## [Unreleased]

- **Mail (breaking)** — not released yet

## [0.3.0] - 2026-10-01

Big release. It spans
two lines.

### Changed

- **Sheets border storage (breaking)** — borders are stored per cell
- **Docs** — nothing breaking here

## [0.2.10] - 2026-09-20

Ten comes after nine.

### Fixed

- **Calendar** — an old bug

## [0.2.9] - 2026-09-10

Nine.

- **Contacts (breaking)** — a new vCard shape

## [0.2.0] - 2026-09-02

The base.
`;

async function eigen(...args: string[]) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, NO_COLOR: '1' },
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

describe('releaseNotes', () => {
    test('lists every version newer than from and not newer than to, oldest first, compared as versions', () => {
        expect(releaseNotes(CHANGELOG, '0.2.0', '0.3.0').map((note) => note.version)).toEqual([
            '0.2.9',
            '0.2.10',
            '0.3.0',
        ]);
        expect(releaseNotes(CHANGELOG, '0.2.9', '0.2.10').map((note) => note.version)).toEqual(['0.2.10']);
    });

    test('each version brings its intro paragraph and its lines marked (breaking)', () => {
        const [nine, ten, three] = releaseNotes(CHANGELOG, '0.2.0', '0.3.0');
        expect(nine).toEqual({
            version: '0.2.9',
            intro: 'Nine.',
            breaking: ['Contacts (breaking) — a new vCard shape'],
        });
        expect(ten).toEqual({ version: '0.2.10', intro: 'Ten comes after nine.', breaking: [] });
        expect(three?.intro).toBe('Big release. It spans two lines.');
        expect(three?.breaking).toEqual(['Sheets border storage (breaking) — borders are stored per cell']);
    });

    test('skips [Unreleased], even when this image is newer than every release', () => {
        const notes = releaseNotes(CHANGELOG, '0.3.0', '9.0.0');
        expect(notes).toEqual([]);
    });

    test('a downgrade or the same version has no notes', () => {
        expect(releaseNotes(CHANGELOG, '0.3.0', '0.2.9')).toEqual([]);
        expect(releaseNotes(CHANGELOG, '0.2.10', '0.2.10')).toEqual([]);
    });
});

describe('update-check', () => {
    test('without breaking changes it prints the notes and exits 0', async () => {
        const run = await eigen('update-check', '--from', version);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
    });

    test('a breaking change is refused without --accept-breaking, and says what to do', async () => {
        const run = await eigen('update-check', '--from', '0.1.1');
        expect(run.code).toBe(1);
        expect(run.stdout).toContain(`◆  Eigen 0.2.0`);
        expect(run.stdout).toContain('Drawing, contacts sync, and hardening release.');
        expect(run.stdout).toContain('▲  Sheets border storage (breaking)');
        expect(run.stderr).toContain(`■  Eigen ${version} has breaking changes, listed above.`);
        expect(run.stderr).toContain('└  Read them, then run ./eigen update --accept-breaking.');
    });

    test('--accept-breaking lets it through', async () => {
        const run = await eigen('update-check', '--from', '0.1.1', '--accept-breaking');
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout).toContain('▲  Sheets border storage (breaking)');
    });

    test('refuses a downgrade', async () => {
        const run = await eigen('update-check', '--from', '99.0.0');
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`■  This is Eigen ${version}, older than 99.0.0.`);
    });

    test('refuses a --from that is no version, and a missing one', async () => {
        expect((await eigen('update-check', '--from', 'latest')).stderr).toContain('■  --from takes a version');
        expect((await eigen('update-check')).stderr).toContain('■  --from takes a version');
    });
});
