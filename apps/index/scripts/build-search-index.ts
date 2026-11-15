// Builds the help center's Pagefind search index from the generated article bodies, one record per help article,
// rather than by crawling the built HTML. It runs after the prerender and writes the bundle into the built site,
// where the Support page's search loads it in the browser.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pagefind from 'pagefind';
import type { ArticleBody, ContentManifest } from './lib/content-types';

const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');

// The bodies are trusted build-time HTML, so a tag strip is enough. A media block's marker goes too.
function htmlToText(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[BLOCK:[\w-]+\]/g, ' ')
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
            // The title and description lead, so they rank and show in the excerpt.
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
