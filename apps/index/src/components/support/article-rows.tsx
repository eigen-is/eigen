// A list of help articles, one row each with the title in medium weight and the description under it. A Support
// section page lists its articles this way, and an article lists its related ones. The rows are the app's list
// rows, so they wash in the page's current color, which a section page sets to the section's.

import { Link } from '@tanstack/react-router';
import type { ArticleMeta } from '../../content/manifest';

export function ArticleRows({ articles }: { articles: ArticleMeta[] }) {
    return (
        <div>
            {articles.map((article) => {
                const [section, file] = article.slug.split('/');
                return (
                    <Link
                        key={article.slug}
                        to="/support/$section/$article"
                        params={{ section, article: file }}
                        className="eigen-list-item -mx-(--app-gutter-x) block px-(--app-gutter-x) py-3"
                    >
                        <span className="block font-medium">{article.title}</span>
                        <span className="block text-sm text-muted-foreground">{article.description}</span>
                    </Link>
                );
            })}
        </div>
    );
}
