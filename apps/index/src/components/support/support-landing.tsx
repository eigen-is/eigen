import { Link } from '@tanstack/react-router';
import { getSupportArticles } from '../../content/manifest';
import { SECTIONS } from './sections';
import { SearchTrigger } from './support-search';

// The help center front door: a hero, a browse-by-app grid, and popular links.
// Full-width and centred — not the column layout. (Search is added in Phase 3.)
export function SupportLanding() {
    const popular = getSupportArticles()
        .filter((a) => a.type === 'overview' || a.type === 'how-to')
        .slice(0, 6);

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-4xl px-6 py-12">
                <h1 className="text-3xl font-bold text-center mb-6">How can we help?</h1>

                <div className="mx-auto max-w-md mb-12">
                    <SearchTrigger className="flex w-full items-center gap-2 rounded-lg border px-4 py-3 text-muted-foreground hover:bg-muted" />
                </div>

                <h2 className="text-sm font-medium text-muted-foreground mb-3">Browse by topic</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-12">
                    {SECTIONS.map((section) => {
                        const Icon = section.icon;
                        return (
                            <Link
                                key={section.id}
                                to="/support/$section"
                                params={{ section: section.id }}
                                className="eigen-list-item flex flex-col gap-1 rounded-lg border p-4 hover:bg-muted"
                            >
                                <Icon className="h-5 w-5 text-muted-foreground" />
                                <span className="font-medium">{section.title}</span>
                                <span className="text-sm text-muted-foreground">{section.description}</span>
                            </Link>
                        );
                    })}
                </div>

                {popular.length > 0 && (
                    <>
                        <h2 className="text-sm font-medium text-muted-foreground mb-3">Popular articles</h2>
                        <ul className="space-y-1">
                            {popular.map((article) => {
                                const [section, file] = article.slug.split('/');
                                return (
                                    <li key={article.slug}>
                                        <Link
                                            to="/support/$section/$article"
                                            params={{ section, article: file }}
                                            className="text-link hover:underline"
                                        >
                                            {article.title}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </div>
        </div>
    );
}
