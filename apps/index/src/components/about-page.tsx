// An app's About page: the headline your own|sheets⟩ with the page's description and the admin's links, then the
// body, which ends with a panel for the reader's technical person, and a pager to the previous and the next app. It
// reads like a blog post, in the reading column with the table of contents in the gutter, and under it a small box for
// each of Eigen's principles the app holds to, such as CalDAV for Calendar. Narrow screens have no gutter, so there
// the boxes sit at the body's end, above the technical panel.

import { Badge } from '@workspace/ui/components/badge';
import type { AboutApp } from '../content/about-apps';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
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
            <ReadingLayout
                aside={
                    <>
                        <ArticleToc toc={page.toc} />
                        <PrincipleBoxes app={app} className="grid gap-4" />
                    </>
                }
            >
                <article>
                    <h1 className="site-title">
                        <AppWordmark prefix="your own" app={app} />
                    </h1>
                    <p className="mt-2 text-muted-foreground">{page.description}</p>
                    <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                        <LandingLinks />
                    </div>
                    <ArticleContent
                        body={body}
                        blocks={{
                            'app-principles': (
                                <PrincipleBoxes
                                    app={app}
                                    className="mt-10 grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4 min-[76rem]:hidden"
                                />
                            ),
                        }}
                        className="mt-8"
                    />
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

function PrincipleBoxes({ app, className }: { app: AboutApp; className: string }) {
    if (app.principles.length === 0) return null;
    return (
        <div className={className}>
            {app.principles.map((entry) => (
                <a
                    key={entry.principle}
                    href={`/support/${entry.article}`}
                    className="group site-panel block text-sm leading-snug"
                >
                    <p className="font-medium underline-offset-4 group-hover:underline">{entry.principle}</p>
                    <p className="mt-1 text-pretty text-muted-foreground">{entry.line}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {entry.tags.map((tag) => (
                            <Badge key={tag} variant="outline">
                                {tag}
                            </Badge>
                        ))}
                    </div>
                </a>
            ))}
        </div>
    );
}
