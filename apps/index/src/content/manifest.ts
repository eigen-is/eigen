// The read side of the generated content: the metadata of every blog post, help article and About page, which is
// small and imported with the code, and the bodies, which load one chunk at a time. The page's own body is inlined
// by the prerender, so the server render and the first client render both have it.

import type { ArticleBody, ArticleMeta, ChangelogBody } from '../../scripts/lib/content-types';
import aboutManifest from './.generated/about.manifest.json';
import blogManifest from './.generated/blog.manifest.json';
import supportManifest from './.generated/support.manifest.json';

export type { ArticleBody, ArticleMeta, ChangelogBody };

export type ArticleCollection = 'blog' | 'support' | 'about';

// The article a page was prerendered for, inlined into that page's HTML so the route component can render its body
// synchronously.
export type PageArticle = { collection: ArticleCollection; slug: string; body: ArticleBody };

const blog: ArticleMeta[] = blogManifest.articles;
const support: ArticleMeta[] = supportManifest.articles;
const about: ArticleMeta[] = aboutManifest.articles;

export function getBlogArticles(): ArticleMeta[] {
    return blog;
}
export function getSupportArticles(): ArticleMeta[] {
    return support;
}
export function getSupportArticle(section: string, file: string): ArticleMeta | undefined {
    return support.find((a) => a.slug === `${section}/${file}`);
}
export function getBlogArticle(id: string): ArticleMeta | undefined {
    return blog.find((a) => a.slug === id);
}

// The build sorts the About pages in the app registry's order. The overview's slug is `index`.
const aboutPages = about.filter((a) => a.slug !== 'index');
export function getAboutOverview(): ArticleMeta {
    const overview = about.find((a) => a.slug === 'index');
    if (!overview) throw new Error('The content build wrote no About overview');
    return overview;
}
export function getAboutArticles(): readonly ArticleMeta[] {
    return aboutPages;
}
export function getAboutArticle(slug: string): ArticleMeta | undefined {
    return aboutPages.find((a) => a.slug === slug);
}

function readInlinedArticle(): PageArticle | null {
    if (typeof document === 'undefined') return null;
    const el = document.getElementById('eigen-article-body');
    return el?.textContent ? (JSON.parse(el.textContent) as PageArticle) : null;
}

let pageArticle: PageArticle | null = readInlinedArticle();

// The server has no DOM to read the inlined <script> from, so the prerender sets each page's body before it renders.
export function setPrerenderBody(article: PageArticle | null): void {
    pageArticle = article;
}

// This page's own body, there on the first render, so the prerender and hydration draw the same thing with no flash.
export function getInlinedBody(collection: ArticleCollection, slug: string): ArticleBody | undefined {
    return pageArticle && pageArticle.collection === collection && pageArticle.slug === slug
        ? pageArticle.body
        : undefined;
}

// Each body is its own chunk outside the shared bundle, so a visitor downloads only the body they open. The glob
// sits in here as only Vite expands it, and the module also loads where Vite does not run, e.g. under bun's own runner.
export function fetchArticleBody(collection: ArticleCollection, slug: string): Promise<ArticleBody> | undefined {
    const bodies = import.meta.glob<ArticleBody>('./.generated/{blog,support,about}/**/*.json', { import: 'default' });
    return bodies[`./.generated/${collection}/${slug}.json`]?.();
}
