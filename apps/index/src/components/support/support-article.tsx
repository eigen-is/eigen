import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import type { ArticleBody, ArticleMeta } from '../../content/manifest';
import { ArticleContent } from '../ArticleContent';
import { ArticleToc } from './article-toc';
import { getSection } from './sections';
import { SupportBreadcrumb } from './support-breadcrumb';

// A full article: body + on-this-page TOC. Section nav lives in the AppShell sidebar.
export function SupportArticle({
    article,
    body,
    related,
}: {
    article: ArticleMeta;
    body: ArticleBody;
    related: ArticleMeta[];
}) {
    const { isMobile } = useLayout();
    const section = article.section;
    const config = getSection(section);
    const sectionTitle = config?.title ?? section;
    const showToc = article.toc.length >= 2;

    return (
        <ColumnLayout mobileColumn="article">
            <Column
                id="article"
                width="flex"
                toolbar={
                    <SupportBreadcrumb
                        trail={[
                            { label: 'Help Center', to: '/support' },
                            { label: sectionTitle, to: `/support/${section}` },
                            { label: article.title },
                        ]}
                    />
                }
            >
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-[70ch] px-6 py-8">
                        <h1 className="text-3xl font-bold mb-1">{article.title}</h1>
                        {article.updated && (
                            <p className="text-sm text-muted-foreground mb-6">Updated {article.updated}</p>
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
                    </div>
                </div>
            </Column>
            {showToc && !isMobile && (
                <Column id="toc" width="260px" toolbar={<span className="text-sm">On this page</span>}>
                    <ArticleToc toc={article.toc} />
                </Column>
            )}
        </ColumnLayout>
    );
}
