// A help center section page: the section's icon and title, its description and the list of its articles, with
// the articles other sections list here too. The page wears the section's color. It sits in the site's reading
// column, under a breadcrumb back to the help center's front page.

import type { ArticleMeta } from '../../content/manifest';
import { ArticleBreadcrumb } from '../article-breadcrumb';
import { ReadingLayout } from '../reading-layout';
import { SitePage } from '../site-page';
import { ArticleRows } from './article-rows';
import { getSection } from './sections';

export function SupportSection({ section, articles }: { section: string; articles: ArticleMeta[] }) {
    const config = getSection(section);
    const sorted = [...articles].sort((a, b) => a.order - b.order);
    const Icon = config?.icon;

    return (
        <SitePage color={config?.color}>
            <ReadingLayout>
                <ArticleBreadcrumb trail={[{ label: 'Support', to: '/support' }]} />
                <h1 className="flex items-center gap-2.5 text-4xl font-medium tracking-tight">
                    {Icon && <Icon className="size-7.5 shrink-0 text-(--app-current-color)" strokeWidth={1.75} />}
                    {config?.title ?? section}
                </h1>
                {config && <p className="mt-2 text-muted-foreground">{config.description}</p>}
                <div className="mt-6">
                    <ArticleRows articles={sorted} />
                </div>
            </ReadingLayout>
        </SitePage>
    );
}
