import { describe, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import pkg from '../../../../../package.json' with { type: 'json' };
import { updateCheck } from '../../cli/update-check';
import { runCli } from '../cli-test-helpers';

const { version } = pkg;

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

const eigen = (...args: string[]) => runCli(args);

// The lines one run prints for a changelog of the test's.
async function notesOf(changelog: string, from: string): Promise<string[]> {
    const read = spyOn(nodeFs, 'readFileSync').mockReturnValue(changelog);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
        await updateCheck({ from, 'accept-breaking': true });
        return log.mock.calls.flat().map(String);
    } finally {
        read.mockRestore();
        log.mockRestore();
    }
}

const versionsIn = (lines: string[]) => lines.flatMap((line) => /◆ {2}Eigen (.+)$/.exec(line)?.[1] ?? []);

describe('the notes of a run', () => {
    test('list every version newer than from and not newer than this one, oldest first, compared as versions', async () => {
        expect(versionsIn(await notesOf(CHANGELOG, '0.2.0'))).toEqual(['0.2.9', '0.2.10', '0.3.0']);
        expect(versionsIn(await notesOf(CHANGELOG, '0.2.9'))).toEqual(['0.2.10', '0.3.0']);
    });

    test('each version brings its intro paragraph and its lines marked (breaking)', async () => {
        const lines = (await notesOf(CHANGELOG, '0.2.0')).join('\n');
        expect(lines).toContain('Nine.');
        expect(lines).toContain('▲  Contacts (breaking) — a new vCard shape');
        expect(lines).toContain('Ten comes after nine.');
        expect(lines).toContain('Big release. It spans two lines.');
        expect(lines).toContain('▲  Sheets border storage (breaking) — borders are stored per cell');
    });

    test('a section that opens with a list has no intro', async () => {
        const lines = await notesOf('## [0.2.1] - 2026-09-01\n\n- **Mail (breaking)** — a new store\n', '0.2.0');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('▲  Mail (breaking) — a new store');
    });

    test('a link reads as its text and its URL, which a wrap never splits', async () => {
        const lines = await notesOf(
            '## [0.2.1] - 2026-09-01\n\nThe steps are in the [Self-hosting\nsection](https://eigen.is/support/self-hosting/get-started).\n\n- **Backups (breaking)** — see [the guide](https://eigen.is/support)\n',
            '0.2.0',
        );
        const text = lines.join('\n');
        expect(text).toContain('Self-hosting section');
        expect(text).toContain('(https://eigen.is/support/self-hosting/get-started).');
        expect(text).toContain('see the guide (https://eigen.is/support)');
    });

    test('skip [Unreleased]', async () => {
        expect(versionsIn(await notesOf(CHANGELOG, '0.3.0'))).toEqual([]);
    });

    test('order prereleases before their release, and their numbers as numbers', async () => {
        const changelog = '## [0.3.0-rc.10] - 2026-10-02\n\nTen.\n\n## [0.3.0-rc.9] - 2026-10-01\n\nNine.\n';
        expect(versionsIn(await notesOf(changelog, '0.3.0-rc.8'))).toEqual(['0.3.0-rc.9', '0.3.0-rc.10']);
    });

    test('hold nothing past this version, or for this version itself', async () => {
        const changelog = `## [99.0.0] - 2099-01-01\n\nLater.\n\n## [${version}] - 2026-01-01\n\nNow.\n`;
        expect(versionsIn(await notesOf(changelog, '0.1.0'))).toEqual([version]);
        expect(versionsIn(await notesOf(changelog, version))).toEqual([]);
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

    test('refuses a downgrade, and takes this version or a prerelease of it', async () => {
        for (const from of ['99.0.0', '99.0.0-rc.1']) {
            const run = await eigen('update-check', '--from', from);
            expect(run.code).toBe(1);
            expect(run.stderr).toContain(`■  Eigen ${version} is older than Eigen ${from}, which runs here.`);
        }
        for (const from of [version, `${version}-rc.1`]) {
            expect((await eigen('update-check', '--from', from, '--accept-breaking')).code).toBe(0);
        }
    });

    test('refuses a --from that is no version, and a missing one', async () => {
        expect((await eigen('update-check', '--from', 'latest')).stderr).toContain('■  --from takes a version');
        expect((await eigen('update-check')).stderr).toContain('■  --from takes a version');
    });
});
