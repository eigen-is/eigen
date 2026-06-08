import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pagefind from 'pagefind';
import type { ArticleBody, ContentManifest } from './lib/content-types';

// Experiment: build a Pagefind search index for the help center from the generated
// content JSON (not by crawling the built HTML). Each support article becomes one
// custom record; the bundle is written to dist/index/pagefind/ and served statically.
// The /support landing loads it client-side — see components/support/support-search.tsx.
const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');

// Rendered article HTML -> plain text for indexing. The bodies are trusted,
// build-time HTML, so a tag strip is enough; also drop the [MEDIAGRID:N] markers
// the renderer leaves in place of media grids and decode the few entities we emit.
function htmlToText(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[MEDIAGRID:\d+\]/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function main() {
    const manifest = JSON.parse(readFileSync(join(GEN, 'support.manifest.json'), 'utf-8')) as ContentManifest;
    const { index } = await pagefind.createIndex({});
    if (!index) throw new Error('Pagefind: failed to create index');

    for (const article of manifest.articles) {
        const body = JSON.parse(readFileSync(join(GEN, 'support', `${article.slug}.json`), 'utf-8')) as ArticleBody;
        const text = htmlToText(body.html);
        await index.addCustomRecord({
            url: `/support/${article.slug}`,
            // Lead with the title + description so they rank and surface in the excerpt.
            content: `${article.title}. ${article.description} ${text}`,
            language: 'en',
            meta: { title: article.title, section: article.section, description: article.description },
            filters: { section: [article.section] },
        });
    }

    await index.writeFiles({ outputPath: join(DIST, 'pagefind') });
    await pagefind.close();
    console.log(`Search index built: ${manifest.articles.length} support articles -> dist/index/pagefind`);
}

main();
