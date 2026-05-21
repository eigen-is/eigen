import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import type { ArticleMeta } from '../../content/manifest';
import { ArticleBreadcrumb } from '../article-breadcrumb';
import { getSection } from './sections';

// A section page: full-width article list, no sidebar (mirrors support-landing.tsx).
export function SupportSection({ section, articles }: { section: string; articles: ArticleMeta[] }) {
    const config = getSection(section);
    const title = config?.title ?? section;
    const sorted = [...articles].sort((a, b) => a.order - b.order);

    return (
        <ColumnLayout>
            <Column
                id="section"
                width="flex"
                toolbar={
                    <div className="mx-auto w-full max-w-2xl px-2">
                        <ArticleBreadcrumb trail={[{ label: 'Eigen Support', to: '/support' }, { label: title }]} />
                    </div>
                }
            >
                <div className="h-full overflow-y-auto px-6 py-6">
                    <div className="mx-auto max-w-2xl">
                        <h1 className="text-2xl font-bold mb-1">{title}</h1>
                        {config && <p className="text-muted-foreground mb-6">{config.description}</p>}
                        <ul className="space-y-1">
                            {sorted.map((article) => {
                                const [articleSection, file] = article.slug.split('/');
                                return (
                                    <li key={article.slug}>
                                        <Link
                                            to="/support/$section/$article"
                                            params={{ section: articleSection, article: file }}
                                            className="text-link hover:underline"
                                        >
                                            {article.title}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
