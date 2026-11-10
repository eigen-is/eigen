// A full help article: the breadcrumb, the title, the date it was updated, the body and the articles related to
// it, in the site's reading column with the table of contents in the gutter. The page wears its section's color.

import { formatDateOnly } from '@workspace/lib/date';
import type { ArticleBody, ArticleMeta } from '../../content/manifest';
import { ArticleBreadcrumb } from '../article-breadcrumb';
import { ArticleContent } from '../article-content';
import { ArticleToc } from '../article-toc';
import { ReadingLayout } from '../reading-layout';
import { SitePage } from '../site-page';
import { ArticleRows } from './article-rows';
import { getSection } from './sections';

type SupportArticleProps = {
    article: ArticleMeta;
    body: ArticleBody;
    related: ArticleMeta[];
};

export function SupportArticle({ article, body, related }: SupportArticleProps) {
    const config = getSection(article.section);

    return (
        <SitePage color={config?.color}>
            <ReadingLayout aside={<ArticleToc toc={article.toc} />}>
                <ArticleBreadcrumb
                    trail={[
                        { label: 'Support', to: '/support' },
                        {
                            label: config?.title ?? article.section,
                            to: `/support/${article.section}`,
                            icon: config?.icon,
                        },
                    ]}
                />
                <h1 className="site-title">{article.title}</h1>
                {article.updated && (
                    <p className="mt-2 text-sm text-muted-foreground">Updated {formatDateOnly(article.updated)}</p>
                )}
                <ArticleContent body={body} className="mt-8" />

                {related.length > 0 && (
                    <section className="mt-12">
                        <p className="eigen-section-label mb-2">Related</p>
                        <ArticleRows articles={related} />
                    </section>
                )}
            </ReadingLayout>
        </SitePage>
    );
}
