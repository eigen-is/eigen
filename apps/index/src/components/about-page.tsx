// An app's About page: the headline your own|sheets⟩ with the page's description and the admin's links, then the
// body, which ends with the block for the reader's technical person, and a pager to the previous and the next app.
// It reads like a blog post, in the reading column with the table of contents in the gutter.

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
            <ReadingLayout aside={<ArticleToc toc={page.toc} />}>
                <article>
                    <h1 className="site-title">
                        <AppWordmark prefix="your own" app={app} />
                    </h1>
                    <p className="mt-2 text-muted-foreground">{page.description}</p>
                    <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                        <LandingLinks />
                    </div>
                    <ArticleContent body={body} className="mt-8" />
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
