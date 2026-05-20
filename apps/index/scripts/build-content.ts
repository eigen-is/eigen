import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMediaGrids } from '../src/components/parse-media-grids';
import type { ArticleBody, ArticleMeta, ContentManifest } from './lib/content-types';
import { blogFrontmatterSchema, supportFrontmatterSchema } from './lib/content-types';
import { parseContentFile } from './lib/frontmatter';
import { resolveRelated } from './lib/related';
import { renderMarkdown } from './lib/render-markdown';

const ROOT = process.cwd(); // apps/index
const DATA = join(ROOT, 'src', 'data');
const OUT = join(ROOT, 'src', 'content', '.generated');

// Recursively list every .md file under `dir`, returning paths relative to `dir`.
function listMarkdown(dir: string, base = ''): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listMarkdown(join(dir, entry.name), rel));
        else if (entry.name.endsWith('.md')) out.push(rel);
    }
    return out;
}

function writeArticle(collection: string, slug: string, body: ArticleBody) {
    const file = join(OUT, collection, `${slug}.json`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
}

function buildSupport(): ArticleMeta[] {
    const dir = join(DATA, 'support');
    const draft: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const slug = rel.replace(/\.md$/, '');
        const section = slug.split('/')[0];
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), supportFrontmatterSchema);
        if (data.draft) continue;
        const { content, mediaGrids } = parseMediaGrids(body);
        const { html, toc } = renderMarkdown(content);
        writeArticle('support', slug, { html, mediaGrids });
        draft.push({
            slug,
            section,
            title: data.title,
            description: data.description,
            type: data.type,
            category: data.category,
            tags: data.tags,
            order: data.order,
            updated: data.updated,
            toc,
            related: data.related,
        });
    }
    return draft.map((a) => ({ ...a, related: resolveRelated(a, draft) }));
}

function buildBlog(): ArticleMeta[] {
    const dir = join(DATA, 'blog');
    const articles: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const dateMatch = rel.match(/^(\d{4}-\d{2}-\d{2})-/);
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), blogFrontmatterSchema);
        const { content, mediaGrids } = parseMediaGrids(body);
        const { html, toc } = renderMarkdown(content);
        writeArticle('blog', data.id, { html, mediaGrids });
        articles.push({
            slug: data.id,
            section: 'blog',
            title: data.title,
            description: data.description,
            tags: [],
            order: 100,
            date: dateMatch ? dateMatch[1] : '',
            toc,
            related: [],
        });
    }
    return articles.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function writeManifest(name: string, articles: ArticleMeta[]) {
    const manifest: ContentManifest = { articles };
    writeFileSync(join(OUT, `${name}.manifest.json`), JSON.stringify(manifest, null, 2));
}

function main() {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const blog = buildBlog();
    const support = buildSupport();
    writeManifest('blog', blog);
    writeManifest('support', support);
    console.log(`Content build: ${blog.length} blog posts, ${support.length} support articles`);
}

main();
