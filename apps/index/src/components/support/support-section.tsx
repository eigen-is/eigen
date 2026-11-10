// A help center section page: the section's title, its description and the list of its articles, with
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

    return (
        <SitePage
            color={config?.color}
            toolbar={
                <ArticleBreadcrumb trail={[{ label: 'Support', to: '/support' }]} page={config?.title ?? section} />
            }
        >
            <ReadingLayout>
                <h1 className="site-title">{config?.title ?? section}</h1>
                {config && <p className="mt-2 text-sm text-muted-foreground">{config.description}</p>}
                <div className="mt-6">
                    <ArticleRows articles={sorted} />
                </div>
            </ReadingLayout>
        </SitePage>
    );
}
