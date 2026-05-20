import type { ArticleBody, ArticleMeta, ContentManifest, TocEntry } from '../../scripts/lib/content-types';
import blogManifest from './.generated/blog.manifest.json';
import supportManifest from './.generated/support.manifest.json';

export type { ArticleBody, ArticleMeta, TocEntry };

const blog = (blogManifest as ContentManifest).articles;
const support = (supportManifest as ContentManifest).articles;

// Article bodies, eager-imported so they resolve synchronously — this keeps the
// prerender and client hydration in lockstep (no async loader data to rehydrate).
// At v1's article count the bundle cost is negligible; switch to a lazy glob with
// loader-data dehydration only if the library grows into the hundreds.
const bodies = import.meta.glob<ArticleBody>('./.generated/{blog,support}/**/*.json', {
    eager: true,
    import: 'default',
});

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

// Get one article's rendered body. Synchronous (bodies are eager-imported), so
// route components read it directly with no loader — prerender and hydration agree.
export function getArticleBody(collection: 'blog' | 'support', slug: string): ArticleBody | undefined {
    return bodies[`./.generated/${collection}/${slug}.json`];
}
