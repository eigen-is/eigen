import type { ArticleMeta } from './content-types';

const MAX_RELATED = 4;

export function resolveRelated(article: ArticleMeta, all: ArticleMeta[]): string[] {
    const bySlug = new Set(all.map((a) => a.slug));

    if (article.related.length > 0) {
        return article.related.filter((slug) => slug !== article.slug && bySlug.has(slug)).slice(0, MAX_RELATED);
    }

    const tags = new Set(article.tags);
    if (tags.size === 0) return [];

    return all
        .filter((a) => a.slug !== article.slug && a.section === article.section)
        .map((a) => ({ slug: a.slug, overlap: a.tags.filter((t) => tags.has(t)).length, order: a.order }))
        .filter((a) => a.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || a.order - b.order || a.slug.localeCompare(b.slug))
        .slice(0, MAX_RELATED)
        .map((a) => a.slug);
}
