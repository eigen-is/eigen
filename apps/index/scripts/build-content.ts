// Turns the site's Markdown into what its pages read: for every help article, blog post and About page a JSON body
// with the rendered HTML, and for each collection a manifest of metadata with the headings and the related articles.
// A bad frontmatter field throws, so a broken article never ships. It runs before the Vite build and the type check.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseMediaGrids } from '../src/components/parse-media-grids';
import { aboutApps, aboutPageSlug, checkAboutRows } from '../src/content/about-apps';
import type { ArticleBody, ArticleMeta, ContentManifest } from './lib/content-types';
import { aboutFrontmatterSchema, blogFrontmatterSchema, supportFrontmatterSchema } from './lib/content-types';
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
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
}

function buildSupport(): ArticleMeta[] {
    const dir = join(DATA, 'support');
    const articles: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const slug = rel.replace(/\.md$/, '');
        const section = slug.split('/')[0];
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), supportFrontmatterSchema);
        if (data.draft) continue;
        const { content, mediaGrids } = parseMediaGrids(body);
        const { html, toc } = renderMarkdown(content);
        writeArticle('support', slug, { html, mediaGrids });
        articles.push({
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
            crossSections: data.crossSections,
        });
    }
    return articles.map((a) => ({ ...a, related: resolveRelated(a, articles) }));
}

function buildBlog(): ArticleMeta[] {
    const dir = join(DATA, 'blog');
    const articles: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const dateMatch = rel.match(/^(\d{4}-\d{2}-\d{2})-/);
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), blogFrontmatterSchema);
        if (data.draft) continue;
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
            cover: data.cover,
            toc,
            related: [],
            crossSections: [],
        });
    }
    return articles.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// The overview and one page per app. Every page ends with the shared block for the technical reader, appended before
// the render so its heading joins the table of contents.
function buildAbout(): ArticleMeta[] {
    const dir = join(DATA, 'about');
    const technical = readFileSync(join(dir, '_technical.md'), 'utf-8');
    const articles: ArticleMeta[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))) {
        const slug = aboutPageSlug(file);
        const { data, body } = parseContentFile(readFileSync(join(dir, file), 'utf-8'), aboutFrontmatterSchema);
        const { content, mediaGrids } = parseMediaGrids(`${body.trimEnd()}\n\n${technical}`);
        const { html, toc } = renderMarkdown(content);
        writeArticle('about', slug, { html, mediaGrids });
        articles.push({
            slug,
            section: 'about',
            title: data.title,
            description: data.description,
            tags: [],
            order: aboutApps.findIndex((app) => app.slug === slug),
            rows: slug === 'index' ? checkAboutRows(data.rows) : undefined,
            toc,
            related: [],
            crossSections: [],
        });
    }
    if (!articles.some((a) => a.slug === 'index')) throw new Error('The About pages need an index.md overview');
    return articles.sort((a, b) => a.order - b.order);
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
    const about = buildAbout();
    writeManifest('blog', blog);
    writeManifest('support', support);
    writeManifest('about', about);
    console.log(
        `Content build: ${blog.length} blog posts, ${support.length} support articles, ${about.length} About pages`,
    );
}

main();
