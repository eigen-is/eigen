// An app's About page: the headline your own|sheets⟩ with the page's description and the admin's links, then the
// body, which ends with a panel on the files and protocols the app speaks, if any, and one for the reader's technical
// person, and a pager to the previous and the next app. It reads like a blog post, in the reading column with the
// table of contents in the gutter.

import { Badge } from '@workspace/ui/components/badge';
import type { AboutApp } from '../content/about-apps';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
import { getSupportArticles } from '../content/manifest';
import { AppWordmark } from './app-wordmark';
import { ArticleBreadcrumb } from './article-breadcrumb';
import { ArticleContent } from './article-content';
import { ArticleToc } from './article-toc';
import { LandingLinks } from './landing-links';
import { PagerLink } from './pager-link';
import { ReadingLayout } from './reading-layout';
import { SitePage } from './site-page';

type AboutPageProps = {
    app: AboutApp;
    page: ArticleMeta;
    body: ArticleBody;
    previous?: ArticleMeta;
    next?: ArticleMeta;
};

export function AboutPage({ app, page, body, previous, next }: AboutPageProps) {
    return (
        <SitePage toolbar={<ArticleBreadcrumb trail={[{ label: 'About', to: '/about' }]} page={app.name} />}>
            <ReadingLayout aside={<ArticleToc toc={page.toc} />}>
                <article>
                    <h1 className="site-title">
                        <AppWordmark prefix="your own" app={app} />
                    </h1>
                    <p className="mt-2 text-muted-foreground">{page.description}</p>
                    <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                        <LandingLinks />
                    </div>
                    <ArticleContent body={body} blocks={{ formats: <FormatsPanel app={app} /> }} className="mt-8" />
                </article>
                {(previous || next) && (
                    <nav className="mt-14 grid grid-cols-2 gap-6 border-t pt-6">
                        {previous ? (
                            <PagerLink
                                label="Previous"
                                title={previous.title}
                                link={{ to: '/about/$app', params: { app: previous.slug } }}
                            />
                        ) : (
                            <span />
                        )}
                        {next ? (
                            <PagerLink
                                label="Next"
                                title={next.title}
                                link={{ to: '/about/$app', params: { app: next.slug } }}
                                className="text-right"
                            />
                        ) : (
                            <span />
                        )}
                    </nav>
                )}
            </ReadingLayout>
        </SitePage>
    );
}

// In the site's prose of its own, so it reads like the technical panel under it.
function FormatsPanel({ app }: { app: AboutApp }) {
    if (!app.formats) return null;
    const { files, protocols, text, article } = app.formats;
    const title = getSupportArticles().find((entry) => entry.slug === article)?.title;
    return (
        <div className="eigen-prose site-prose">
            <aside className="site-panel">
                <h2>Open, and yours to take</h2>
                <p>
                    {text} More in <a href={`/support/${article}`}>{title}</a>.
                </p>
                <div className="flex flex-wrap gap-1.5">
                    {[...files, ...protocols].map((tag) => (
                        <Badge key={tag} variant="outline">
                            {tag}
                        </Badge>
                    ))}
                </div>
            </aside>
        </div>
    );
}
