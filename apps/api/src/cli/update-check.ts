import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../../../package.json' with { type: 'json' };
import { createUi, glyphLine, wrap } from './ui';

export type ReleaseNote = { version: string; intro: string; breaking: string[] };

// The repo root in a checkout, /app in the image: this image's own changelog, which knows every version up to it.
const CHANGELOG = join(import.meta.dir, '../../../../CHANGELOG.md');
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const HEADING = /^\[(\d+\.\d+\.\d+(?:-[\w.-]+)?)\]/;
// The exit code of an update the operator said no to, which the launcher ends as a plain exit.
const DECLINED = 3;

export const UPDATE_CHECK_OPTIONS = { from: { type: 'string' }, 'accept-breaking': { type: 'boolean' } } as const;
export const UPDATE_CHECK_USAGE = `Usage: update-check --from <version> [--accept-breaking]

Prints what changed between <version> and this image's version, from its CHANGELOG.md.
A breaking change is asked about on a terminal and refused elsewhere (run by ./eigen update).

  --accept-breaking   Go ahead despite breaking changes`;

// The CHANGELOG sections after `from` up to `to`, oldest first: each one's first paragraph and its lines marked
// (breaking). [Unreleased] has no version, so it never counts.
export function releaseNotes(changelog: string, from: string, to: string): ReleaseNote[] {
    return changelog
        .split(/^## /m)
        .flatMap((section) => {
            const [heading = '', ...lines] = section.split('\n');
            const version = HEADING.exec(heading)?.[1];
            if (!version || Bun.semver.order(version, from) <= 0 || Bun.semver.order(version, to) > 0) return [];
            const start = lines.findIndex((line) => line.trim());
            const end = lines.findIndex((line, index) => index > start && !line.trim());
            const paragraph = lines.slice(start, end === -1 ? undefined : end).map((line) => line.trim());
            return [
                {
                    version,
                    intro: paragraph[0]?.startsWith('#') ? '' : paragraph.join(' '),
                    breaking: lines
                        .filter((line) => line.includes('(breaking)'))
                        .map((line) => line.replace(/^\s*-\s*/, '').replaceAll('**', '')),
                },
            ];
        })
        .sort((a, b) => Bun.semver.order(a.version, b.version));
}

export async function updateCheck(flags: { from?: string; 'accept-breaking'?: boolean }): Promise<void> {
    const ui = await createUi(false);
    const from = flags.from ?? '';
    if (!VERSION.test(from)) ui.fail('--from takes a version, like 0.2.0.', 'Run it through ./eigen update.');
    if (Bun.semver.order(from, pkg.version) > 0) {
        ui.fail(`This is Eigen ${pkg.version}, older than ${from}.`, 'Run ./eigen update without a version.');
    }

    const notes = releaseNotes(readFileSync(CHANGELOG, 'utf8'), from, pkg.version);
    for (const { version, intro, breaking } of notes) {
        console.log(glyphLine('active', `Eigen ${version}`));
        for (const line of wrap(intro, 76)) if (line) console.log(glyphLine('bar', line));
        for (const change of breaking) {
            const [first = '', ...rest] = wrap(change, 76);
            console.log([glyphLine('warn', first), ...rest.map((line) => glyphLine('bar', line))].join('\n'));
        }
    }
    if (flags['accept-breaking'] || !notes.some(({ breaking }) => breaking.length)) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        ui.fail(
            `Eigen ${pkg.version} has breaking changes, listed above.`,
            'Read them, then run ./eigen update --accept-breaking.',
        );
    }
    const go = await ui.confirm({
        message: `Update to Eigen ${pkg.version} despite the breaking changes above?`,
        initial: false,
        flag: '--accept-breaking',
    });
    if (!go) {
        ui.outro('Nothing was changed.');
        process.exit(DECLINED);
    }
}
