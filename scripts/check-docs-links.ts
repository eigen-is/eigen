// Enforce that documentation links and backtick'd repo paths point at things that exist.
//
// Docs drift when files move and their references don't. Two checks: relative markdown links
// (the target must resolve on disk) and inline `apps/…`|`packages/…`|`docker/…`|`scripts/…`
// code paths (the file must exist). See docs/TESTING.md.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Glob } from 'bun';

const files: string[] = ['AGENTS.md', 'README.md'];
for await (const entry of new Glob('**/*.md').scan('docs')) {
    const path = `docs/${entry.replaceAll('\\', '/')}`;
    if (path.startsWith('docs/superpowers/')) continue;
    files.push(path);
}
files.sort();

// A backtick'd repo path: one of the four roots, an extension we care about, no glob/placeholder chars.
const REPO_PATH = /^(apps|packages|docker|scripts)\/[^\s*{[<]+\.(ts|tsx|js|sh|md|cf|json|css|yml|yaml)$/;

const offenders: string[] = [];

for (const file of files) {
    const content = await Bun.file(file).text();
    const dir = dirname(file);

    // Fenced code blocks are examples, not inline spans — drop them so backtick pairing stays aligned.
    const withoutFences = content.replace(/```[\s\S]*?```/g, '');

    // Proposals name files they propose to create — a path there not existing is the norm, not drift.
    if (!file.startsWith('docs/proposals/')) {
        for (const match of withoutFences.matchAll(/`([^`]+)`/g)) {
            const path = match[1].replace(/:\d+$/, '');
            if (path.includes('...') || !REPO_PATH.test(path)) continue;
            if (!existsSync(path)) offenders.push(`${file} -> ${path}`);
        }
    }

    // A link inside a code span is literal text, not a link — strip inline code before scanning links.
    for (const match of withoutFences.replace(/`[^`]+`/g, '').matchAll(/\]\(([^)]+)\)/g)) {
        const raw = match[1];
        if (/^(https?:\/\/|mailto:|#)/.test(raw)) continue;
        const target = raw.split('#')[0];
        if (target === '') continue;
        if (!existsSync(resolve(dir, target))) offenders.push(`${file} -> ${target}`);
    }
}

if (offenders.length > 0) {
    console.error('ERROR: documentation references a path that does not exist\n');
    for (const offender of offenders) console.error(`  ${offender}`);
    console.error('\nUpdate the link/path to its new location. See docs/TESTING.md.');
    process.exit(1);
}
