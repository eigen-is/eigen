// The read side of the generated content: the metadata of every blog post, help article and About page, which is
// small and imported with the code, and the bodies, which load one chunk at a time. The page's own body is inlined
// by the prerender, so the server render and the first client render both have it.

import type { ArticleBody, ArticleMeta, ChangelogBody, ContentManifest } from '../../scripts/lib/content-types';
import aboutManifest from './.generated/about.manifest.json';
import blogManifest from './.generated/blog.manifest.json';
import supportManifest from './.generated/support.manifest.json';

export type { ArticleBody, ArticleMeta, ChangelogBody };

export type ArticleCollection = 'blog' | 'support' | 'about';

// The article a page was prerendered for, inlined into that page's HTML so the route component can render its body
// synchronously.
export type PageArticle = { collection: ArticleCollection; slug: string; body: ArticleBody };

// A JSON import types a heading's level as a number, so the manifests take their shape from the build's type here.
const [blog, support, about] = [blogManifest, supportManifest, aboutManifest].map(
    (manifest) => (manifest as ContentManifest).articles,
);

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
export function getAboutOverview(): ArticleMeta | undefined {
    return about.find((a) => a.slug === 'index');
}
export function getAboutArticles(): readonly ArticleMeta[] {
    return aboutPages;
}
export function getAboutArticle(slug: string): ArticleMeta | undefined {
    return aboutPages.find((a) => a.slug === slug);
}

// Article bodies are imported lazily: each .json becomes its own chunk and stays
// out of the shared bundle, so a visitor only ever downloads the body they open.
const bodies = import.meta.glob<ArticleBody>('./.generated/{blog,support,about}/**/*.json', {
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

// The server has no DOM to read the inlined <script> from, so the prerender sets each page's body before it renders.
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
