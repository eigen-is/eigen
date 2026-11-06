// What ./eigen update asks the new image before it switches: the CHANGELOG sections since the running version, with
// their breaking changes. A breaking change is asked about on a terminal and refused elsewhere.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { parseArgs } from 'node:util';
import { DECLINED, ROOT, VERSION, VERSION_PATTERN } from './install';
import { createUi, glyphLine, wrap } from './ui';

type ReleaseNote = { version: string; intro: string; breaking: string[] };

// This image's own changelog, which knows every version up to it.
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
// A release whose update asks first, and refuses without a terminal.
const BREAKING_MARKER = '(breaking)';
const HEADING = /^\[([^\]]+)\]/;
// A terminal shows a link as its text and its URL, a word wrap() keeps whole.
const plainLinks = (text: string) => text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

export const UPDATE_CHECK_OPTIONS = {
    from: { type: 'string' },
    'accept-breaking': { type: 'boolean' },
} as const;
export const UPDATE_CHECK_USAGE = `Usage: update-check --from <version> [--accept-breaking]

Prints what changed between <version> and this image's version, from its CHANGELOG.md.
A breaking change is asked about on a terminal and refused elsewhere (run by ./eigen update).

  --accept-breaking   Go ahead despite breaking changes`;

export async function updateCheck(
    flags: ReturnType<typeof parseArgs<{ options: typeof UPDATE_CHECK_OPTIONS }>>['values'],
): Promise<void> {
    const ui = await createUi(false);
    const from = flags.from ?? '';
    if (!VERSION_PATTERN.test(from)) ui.fail('--from takes a version, like 0.2.0.', 'Run it through ./eigen update.');
    if (Bun.semver.order(from, VERSION) > 0) {
        ui.fail(
            `Eigen ${VERSION} is older than Eigen ${from}, which runs here.`,
            './eigen rollback goes back to the version before the last update.',
        );
    }

    const notes = releaseNotes(readFileSync(CHANGELOG_PATH, 'utf8'), from, VERSION);
    for (const { version, intro, breaking } of notes) {
        console.log(glyphLine('active', `Eigen ${version}`));
        for (const line of wrap(intro, 76)) if (line) console.log(glyphLine('bar', line));
        for (const change of breaking) {
            const [first = '', ...rest] = wrap(change, 76);
            console.log([glyphLine('warn', first), ...rest.map((line) => glyphLine('bar', line))].join('\n'));
        }
    }
    if (flags['accept-breaking'] || !hasBreaking(notes)) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        ui.fail(
            `Eigen ${VERSION} has breaking changes, listed above.`,
            'Read them, then run ./eigen update --accept-breaking.',
        );
    }
    const go = await ui.confirm({
        message: `Update to Eigen ${VERSION} despite the breaking changes above?`,
        initial: false,
        flag: '--accept-breaking',
    });
    if (!go) {
        ui.outro('Nothing was changed.');
        process.exit(DECLINED);
    }
}

// A section's list items marked (breaking), as plain text.
function breakingLines(lines: string[]): string[] {
    return lines
        .filter((line) => line.includes(BREAKING_MARKER))
        .map((line) => plainLinks(line.replace(/^\s*-\s*/, '').replaceAll('**', '')));
}

// The CHANGELOG sections after `from` up to `to`, oldest first, with their intro and their (breaking) lines.
export function releaseNotes(changelog: string, from: string, to: string): ReleaseNote[] {
    const sections = changelog.split(/^## /m).flatMap((section) => {
        const [heading = '', ...lines] = section.split('\n');
        const version = HEADING.exec(heading)?.[1];
        return version ? [{ version, lines }] : [];
    });
    const released = sections
        .filter(
            ({ version }) =>
                VERSION_PATTERN.test(version) &&
                Bun.semver.order(version, from) > 0 &&
                Bun.semver.order(version, to) <= 0,
        )
        .sort((a, b) => Bun.semver.order(a.version, b.version));
    return released.map(({ version, lines }) => {
        const start = lines.findIndex((line) => line.trim());
        const end = lines.findIndex((line, index) => index > start && !line.trim());
        const paragraph = lines.slice(start, end === -1 ? undefined : end).map((line) => line.trim());
        return {
            version,
            // A section that opens with a heading or a list has no intro.
            intro: /^[#*-]/.test(paragraph[0] ?? '') ? '' : plainLinks(paragraph.join(' ')),
            breaking: breakingLines(lines),
        };
    });
}

function hasBreaking(notes: ReleaseNote[]): boolean {
    return notes.some(({ breaking }) => breaking.length > 0);
}
