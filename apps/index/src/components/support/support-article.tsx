import { Link } from '@tanstack/react-router';
import { formatDateOnly } from '@workspace/lib/date';
import { Column, ColumnLayout } from '@workspace/ui';
import type { ArticleBody, ArticleMeta } from '../../content/manifest';
import { ArticleBreadcrumb } from '../article-breadcrumb';
import { ArticleContent } from '../article-content';
import { ArticleToc } from './article-toc';
import { getSection } from './sections';

// A full article: a single centered column with a sticky on-this-page TOC in the gutter.
export function SupportArticle({
    article,
    body,
    related,
}: {
    article: ArticleMeta;
    body: ArticleBody;
    related: ArticleMeta[];
}) {
    const section = article.section;
    const config = getSection(section);
    const sectionTitle = config?.title ?? section;
    const showToc = article.toc.length >= 2;

    return (
        <ColumnLayout>
            <Column
                id="article"
                width="flex"
                toolbar={
                    <div className="mx-auto w-full max-w-[70ch]">
                        <ArticleBreadcrumb
                            trail={[
                                { label: 'Eigen Support', to: '/support' },
                                { label: sectionTitle, to: `/support/${section}` },
                                { label: article.title },
                            ]}
                        />
                    </div>
                }
            >
                <div className="h-full overflow-y-auto scroll-smooth">
                    <div className="grid grid-cols-1 gap-x-8 px-4 py-10 xl:grid-cols-[1fr_minmax(0,70ch)_1fr]">
                        {showToc && (
                            <aside className="hidden xl:block xl:justify-self-end">
                                <div className="sticky top-10 w-56">
                                    <ArticleToc toc={article.toc} />
                                </div>
                            </aside>
                        )}
                        <article className="mx-auto w-full max-w-[70ch]">
                            <h1 className="text-3xl font-medium mb-1">{article.title}</h1>
                            {article.updated && (
                                <p className="text-sm text-muted-foreground mb-6">
                                    last updated at: {formatDateOnly(article.updated)}
                                </p>
                            )}
                            <ArticleContent body={body} className="eigen-prose" />

                            {related.length > 0 && (
                                <div className="mt-12 pt-6 border-t">
                                    <h2 className="text-sm font-medium text-muted-foreground mb-2">Related</h2>
                                    <ul className="space-y-1">
                                        {related.map((r) => {
                                            const [s, f] = r.slug.split('/');
                                            return (
                                                <li key={r.slug}>
                                                    <Link
                                                        to="/support/$section/$article"
                                                        params={{ section: s, article: f }}
                                                        className="text-link hover:underline"
                                                    >
                                                        {r.title}
                                                    </Link>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}
                        </article>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
