import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { ArticleMeta } from '../../content/manifest';

// The left-column list of a section's articles, grouped by `category`.
export function SectionNav({
    section,
    articles,
    activeSlug,
}: {
    section: string;
    articles: ArticleMeta[];
    activeSlug?: string;
}) {
    const groups = new Map<string, ArticleMeta[]>();
    for (const article of [...articles].sort((a, b) => a.order - b.order)) {
        const key = article.category ?? '';
        let group = groups.get(key);
        if (!group) {
            group = [];
            groups.set(key, group);
        }
        group.push(article);
    }

    return (
        <nav className="h-full overflow-y-auto p-3 text-sm">
            {[...groups.entries()].map(([category, items]) => (
                <div key={category} className="mb-4">
                    {category && (
                        <div className="px-2 mb-1 text-xs font-medium uppercase text-muted-foreground">{category}</div>
                    )}
                    {items.map((article) => {
                        const file = article.slug.split('/')[1];
                        return (
                            <Link
                                key={article.slug}
                                to="/support/$section/$article"
                                params={{ section, article: file }}
                                className={cn(
                                    'block rounded px-2 py-1 hover:bg-muted',
                                    article.slug === activeSlug && 'bg-muted font-medium',
                                )}
                            >
                                {article.title}
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
