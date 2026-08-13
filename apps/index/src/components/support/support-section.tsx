import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui';
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
                    <div className="mx-auto w-full max-w-[70ch]">
                        <ArticleBreadcrumb trail={[{ label: 'Eigen Support', to: '/support' }, { label: title }]} />
                    </div>
                }
            >
                <div className="h-full overflow-y-auto px-4 py-10">
                    <div className="mx-auto max-w-[70ch]">
                        <h1 className="text-3xl font-medium mb-1">{title}</h1>
                        {config && <p className="text-muted-foreground mb-6">{config.description}</p>}
                        <ul className="list-disc pl-6 space-y-1 marker:text-muted-foreground">
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
