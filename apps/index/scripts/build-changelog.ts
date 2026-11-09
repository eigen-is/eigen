// Turns CHANGELOG.md into the HTML the changelog page shows. Each release becomes a section with a
// heading of version and date, and each entry's bold title becomes a lead. It also lists the versions
// for the page's table of contents. It runs as part of the build, and the page reads the JSON it writes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatDateOnly } from '@workspace/lib/date';
import type { ChangelogBody, ChangelogVersion } from './lib/content-types';
import { renderMarkdown } from './lib/render-markdown';

// "## [0.4.2] - 2026-11-03" or "## [Unreleased]", with the id and the copy-link anchor markdown-it added.
const RELEASE_HEADING = /^<h2 id="([^"]+)"[^>]*>\[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))? (<a [\s\S]*?<\/a>)<\/h2>/;
// "- **Title** — text", up to the end of the entry's first paragraph.
const LEAD_ENTRY = /<li>(\s*(?:<p>)?)<strong>([\s\S]*?)<\/strong>\s*—\s*(\S)([\s\S]*?)(<\/p>|<\/li>)/g;
const H3_LABEL = /<h3 [^>]*>(.*?) <a [\s\S]*?<\/a><\/h3>/g;

// The page renders its own h1, so everything before the first version heading is dropped.
export function renderChangelog(raw: string): ChangelogBody {
    const start = raw.search(/^## /m);
    const { html } = renderMarkdown(start >= 0 ? raw.slice(start) : raw);
    const versions: ChangelogVersion[] = [];

    const releases = html.split(/(?=<h2 )/).map((release) => {
        const heading = RELEASE_HEADING.exec(release);
        if (!heading) return release;
        const [match, id, version, date, anchor] = heading;
        const time = date
            ? `<time datetime="${date}">${formatDateOnly(date)}</time>`
            : '<time>Not in a release yet</time>';
        versions.push(date ? { id, version, date: formatDateOnly(date).replace(/ \d{4}$/, '') } : { id, version });
        const head = `<h2 id="${id}" class="release-head"><span class="ver">${version}</span>${time} ${anchor}</h2>`;
        return `<section class="release">${head}${release.slice(match.length)}</section>`;
    });

    const body = releases
        .join('')
        .replace(H3_LABEL, '<h3>$1</h3>')
        .replace(LEAD_ENTRY, (_entry, open: string, title: string, first: string, rest: string, close: string) => {
            const text = first.toUpperCase() + rest;
            const ends = /[.!?:]$/.test(text.replace(/<[^>]*>/g, '').trimEnd());
            return `<li>${open}<strong class="lead">${title}</strong> ${text}${ends ? '' : '.'}${close}`;
        });
    return { html: body, mediaGrids: [], versions };
}

// Run only when executed directly (bun run scripts/build-changelog.ts), not when the
// test imports renderChangelog, so importing the module has no filesystem side effects.
if (import.meta.main) {
    // apps/index/scripts → repo root is three levels up.
    const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
    const OUT = join(import.meta.dir, '..', 'src', 'content', '.generated', 'changelog.json');
    const body = renderChangelog(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8'));
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(body));
    console.log(`✓ Wrote ${OUT}`);
}
