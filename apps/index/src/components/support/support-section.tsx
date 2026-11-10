// A help center section page: the section's title, its description and the list of its articles, with
// the articles other sections list here too. The page wears the section's color. With no table of contents it spans
// the site's wide container, under a breadcrumb back to the help center's front page.

import type { ArticleMeta } from '../../content/manifest';
import { ArticleBreadcrumb } from '../article-breadcrumb';
import { SitePage } from '../site-page';
import { ArticleRows } from './article-rows';
import type { SectionConfig } from './sections';

export function SupportSection({ section, articles }: { section: SectionConfig; articles: ArticleMeta[] }) {
    const sorted = [...articles].sort((a, b) => a.order - b.order);

    return (
        <SitePage
            color={section.color}
            toolbar={<ArticleBreadcrumb trail={[{ label: 'Support', to: '/support' }]} page={section.title} />}
        >
            <div className="site-wide py-12">
                <h1 className="site-title">{section.title}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{section.description}</p>
                <div className="mt-6">
                    <ArticleRows articles={sorted} />
                </div>
            </div>
        </SitePage>
    );
}
