import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import type { ArticleMeta } from '../../content/manifest';
import { SectionNav } from './section-nav';
import { getSection } from './sections';
import { SupportBreadcrumb } from './support-breadcrumb';

// A section landing page: section nav + the section's articles.
export function SupportSection({ section, articles }: { section: string; articles: ArticleMeta[] }) {
    const config = getSection(section);
    const title = config?.title ?? section;
    const sorted = [...articles].sort((a, b) => a.order - b.order);

    return (
        <ColumnLayout mobileColumn="list">
            <Column id="nav" width="260px" toolbar={<span className="text-sm">Help Center</span>}>
                <SectionNav section={section} articles={articles} />
            </Column>
            <Column
                id="list"
                width="flex"
                onBack={() => history.back()}
                toolbar={<SupportBreadcrumb trail={[{ label: 'Help Center', to: '/support' }, { label: title }]} />}
            >
                <div className="h-full overflow-y-auto px-6 py-6 max-w-2xl">
                    <h1 className="text-2xl font-bold mb-1">{title}</h1>
                    {config && <p className="text-muted-foreground mb-6">{config.description}</p>}
                    <ul className="space-y-1">
                        {sorted.map((article) => {
                            const file = article.slug.split('/')[1];
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
                </div>
            </Column>
        </ColumnLayout>
    );
}
