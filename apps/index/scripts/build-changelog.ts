import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArticleBody } from './lib/content-types';
import { renderMarkdown } from './lib/render-markdown';

// Render the changelog markdown into an ArticleBody. The page renders its own styled
// <h1>, so we drop everything before the first version heading ("## …") — the prose body
// then starts at <h2>, matching how blog post bodies start. The changelog has no media
// grids, so mediaGrids is always empty.
export function renderChangelog(raw: string): ArticleBody {
    const i = raw.search(/^## /m);
    const { html } = renderMarkdown(i >= 0 ? raw.slice(i) : raw);
    return { html, mediaGrids: [] };
}

// Run only when executed directly (bun run scripts/build-changelog.ts), not when the
// test imports renderChangelog — so importing the module has no filesystem side effects.
if (import.meta.main) {
    // apps/index/scripts → repo root is three levels up.
    const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
    const OUT = join(import.meta.dir, '..', 'src', 'content', '.generated', 'changelog.json');
    const body = renderChangelog(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8'));
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(body));
    console.log(`✓ Wrote ${OUT}`);
}
