// An app's About page: the headline your own|sheets⟩ with the page's description, then the body, which ends with a
// panel for the reader's technical person, and a pager to the previous and the next app. It reads like a blog post, in
// the reading column with the table of contents in the gutter, and under it a small box for each of Eigen's principles
// the app holds to, such as CalDAV for Calendar, and a line to the app's whole help section. Narrow screens have no
// gutter, so there the boxes and the line follow the body and its technical panel.

import type { AboutApp } from '../content/about-apps';
import { principleLabels } from '../content/about-apps';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
import { AppWordmark } from './app-wordmark';
import { ArticleBreadcrumb } from './article-breadcrumb';
import { ArticleContent } from './article-content';
import { ArticleToc } from './article-toc';
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
                        <HelpSectionLink app={app} />
                    </>
                }
            >
                <article>
                    <h1 className="site-title">
                        <AppWordmark prefix="your own" app={app} />
                    </h1>
                    <p className="mt-2 text-muted-foreground">{page.description}</p>
                    <ArticleContent body={body} className="mt-8" />
                    <div className="mt-10 grid gap-4 min-[76rem]:hidden">
                        <PrincipleBoxes
                            app={app}
                            className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4"
                        />
                        <HelpSectionLink app={app} />
                    </div>
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
                    className="site-panel block text-sm leading-snug text-muted-foreground transition-colors hover:text-foreground"
                >
                    <p className="eigen-section-label mb-2 leading-5">{principleLabels[entry.principle]}</p>
                    <p className="text-pretty">{entry.line}</p>
                </a>
            ))}
        </div>
    );
}

// An app's help section has the app's slug as its id, such as /support/mail.
function HelpSectionLink({ app }: { app: AboutApp }) {
    return (
        <a
            href={`/support/${app.slug}`}
            className="px-5 text-sm leading-snug text-muted-foreground transition-colors hover:text-foreground"
        >
            All {app.name} help articles&nbsp;<span aria-hidden>→</span>
        </a>
    );
}
