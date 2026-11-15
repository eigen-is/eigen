// Turns the site's Markdown into what its pages read: for every help article, blog post and About page a JSON body
// with the rendered HTML, and for each collection a manifest of metadata with the headings and the related articles.
// A bad frontmatter field throws, so a broken article never ships. It runs before the Vite build and the type check.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aboutApps } from '../src/content/about-apps';
import { aboutPageSlug, checkAboutRows, checkPrincipleArticles } from './lib/about-pages';
import type { ArticleBody, ArticleMeta, ContentManifest } from './lib/content-types';
import { aboutFrontmatterSchema, blogFrontmatterSchema, supportFrontmatterSchema } from './lib/content-types';
import { parseContentFile } from './lib/frontmatter';
import { resolveRelated } from './lib/related';
import { renderMarkdown } from './lib/render-markdown';

const ROOT = process.cwd(); // apps/index
const DATA = join(ROOT, 'src', 'data');
const OUT = join(ROOT, 'src', 'content', '.generated');

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
        const { html, toc, media } = renderMarkdown(body);
        writeArticle('support', slug, { html, media });
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
        const { html, toc, media } = renderMarkdown(body);
        writeArticle('blog', data.id, { html, media });
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

// The blocks the About pages draw themselves, such as the overview's app rows. No other collection has any.
const ABOUT_BLOCKS = new Set(['apps']);

// The overview first, then one page per app in the registry's order. Every page ends with the shared note for the
// technical reader in a panel, appended after the render so nothing in it reaches the table of contents.
function buildAbout(): ArticleMeta[] {
    const dir = join(DATA, 'about');
    const technical = renderMarkdown(readFileSync(join(dir, '_technical.md'), 'utf-8')).html;
    let overview: ArticleMeta | undefined;
    const pages: ArticleMeta[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))) {
        const slug = aboutPageSlug(file);
        const { data, body } = parseContentFile(readFileSync(join(dir, file), 'utf-8'), aboutFrontmatterSchema);
        if (slug !== 'index' && data.rows) throw new Error(`About page ${file} has rows, which only index.md takes`);
        const { html, toc, media } = renderMarkdown(body, ABOUT_BLOCKS);
        writeArticle('about', slug, { html: `${html}<aside class="site-panel">\n${technical}</aside>\n`, media });
        const article: ArticleMeta = {
            slug,
            section: 'about',
            title: data.title,
            description: data.description,
            tags: [],
            order: aboutApps.findIndex((app) => app.slug === slug),
            toc,
            related: [],
            crossSections: [],
        };
        if (slug === 'index') overview = { ...article, rows: checkAboutRows(data.rows) };
        else pages.push(article);
    }
    if (!overview) throw new Error('The About pages need an index.md overview');
    return [overview, ...pages.sort((a, b) => a.order - b.order)];
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
    checkPrincipleArticles(new Set(support.map((article) => article.slug)));
    const about = buildAbout();
    writeManifest('blog', blog);
    writeManifest('support', support);
    writeManifest('about', about);
    console.log(
        `Content build: ${blog.length} blog posts, ${support.length} support articles, ${about.length} About pages`,
    );
}

main();
