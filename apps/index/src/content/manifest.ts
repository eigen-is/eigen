import type { ArticleBody, ArticleMeta, ContentManifest, TocEntry } from '../../scripts/lib/content-types';
import blogManifest from './.generated/blog.manifest.json';
import supportManifest from './.generated/support.manifest.json';

export type { ArticleBody, ArticleMeta, TocEntry };

export type ArticleCollection = 'blog' | 'support';

// The article a page was prerendered for, inlined into that page's HTML so the
// route component can render its body synchronously (see scripts/prerender.tsx).
export type PageArticle = { collection: ArticleCollection; slug: string; body: ArticleBody };

const blog = (blogManifest as ContentManifest).articles;
const support = (supportManifest as ContentManifest).articles;

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

// Article bodies are imported lazily: each .json becomes its own chunk and stays
// out of the shared bundle, so a visitor only ever downloads the body they open.
const bodies = import.meta.glob<ArticleBody>('./.generated/{blog,support}/**/*.json', {
    import: 'default',
});

// The body the prerender inlined for this page. On the client it comes from the
// JSON <script>; on the server the prerender supplies it via setPrerenderBody.
function readInlinedArticle(): PageArticle | null {
    if (typeof document === 'undefined') return null;
    const el = document.getElementById('eigen-article-body');
    return el?.textContent ? (JSON.parse(el.textContent) as PageArticle) : null;
}

let pageArticle: PageArticle | null = readInlinedArticle();

// Called by entry-server.tsx before each prerender render — the server has no DOM
// to read the inlined <script> from.
export function setPrerenderBody(article: PageArticle | null): void {
    pageArticle = article;
}

// This page's own body, available synchronously, or undefined for any other
// article. Lets the prerender and hydration render the same thing with no flash.
export function getInlinedBody(collection: ArticleCollection, slug: string): ArticleBody | undefined {
    return pageArticle && pageArticle.collection === collection && pageArticle.slug === slug
        ? pageArticle.body
        : undefined;
}

// Lazy-load an article body — used when navigating to an article other than the
// one this page was prerendered for. undefined if the slug has no body file.
export function fetchArticleBody(collection: ArticleCollection, slug: string): Promise<ArticleBody> | undefined {
    return bodies[`./.generated/${collection}/${slug}.json`]?.();
}
