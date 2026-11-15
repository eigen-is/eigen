// The About overview: what eigen is, the admin's links, and the body, in the reading column with the table of
// contents of its headings in the gutter. Where its `::: apps` block stands it draws a row for every app in the
// registry's order, with a still of the app, its eigen|app⟩ wordmark and one line; a row links to its app's page once
// that page is written, and each washes in its own app's color. Where its `::: principles` block stands it draws the
// landing page's blocks on what Eigen stands for, as wide as they are there.

import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { AboutApp } from '../content/about-apps';
import { aboutApps } from '../content/about-apps';
import { aboutRowStill } from '../content/about-media';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
import { getAboutArticles } from '../content/manifest';
import { AppWordmark } from './app-wordmark';
import { ArticleContent } from './article-content';
import { ArticleToc } from './article-toc';
import { PrincipleBlocks } from './landing-blocks';
import { LandingLinks } from './landing-links';
import { ReadingLayout } from './reading-layout';
import { SitePage } from './site-page';

type AboutOverviewProps = {
    overview: ArticleMeta;
    body: ArticleBody;
};

export function AboutOverview({ overview, body }: AboutOverviewProps) {
    return (
        <SitePage>
            <ReadingLayout aside={<ArticleToc toc={overview.toc} />}>
                <h1 className="site-title">{overview.title}</h1>
                <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                    <LandingLinks />
                </div>
                <ArticleContent
                    body={body}
                    blocks={{
                        principles: <PrincipleBlocks className="site-reading-wide my-8" />,
                        apps: <AppRows rows={overview.rows} />,
                    }}
                    className="mt-8"
                />
            </ReadingLayout>
        </SitePage>
    );
}

function AppRows({ rows }: { rows: ArticleMeta['rows'] }) {
    const written = new Set(getAboutArticles().map((page) => page.slug));
    return (
        <div className="mb-3">
            {aboutApps.map((app, index) => {
                const hasPage = written.has(app.slug);
                const className = cn(
                    '-mx-(--app-gutter-x) flex items-center gap-4 px-(--app-gutter-x) py-3.5',
                    hasPage && 'eigen-list-item',
                    index > 0 && 'border-t',
                );
                const style = {
                    '--app-current-color': app.color,
                    '--app-current-color-soft': `var(--app-${app.slug}-color-soft)`,
                };
                const row = <AppRow app={app} line={rows?.[app.slug]} />;
                return hasPage ? (
                    <Link
                        key={app.slug}
                        to="/about/$app"
                        params={{ app: app.slug }}
                        className={className}
                        style={style}
                    >
                        {row}
                    </Link>
                ) : (
                    <div key={app.slug} className={className} style={style}>
                        {row}
                    </div>
                );
            })}
        </div>
    );
}

function AppRow({ app, line }: { app: AboutApp; line?: string }) {
    return (
        <>
            <img
                src={aboutRowStill(app.slug)}
                alt=""
                className="aspect-video w-28 shrink-0 rounded-md border bg-muted object-cover object-top"
            />
            <span className="min-w-0">
                <AppWordmark prefix="eigen" app={app} className="block text-xl" />
                <span className="mt-1 block text-muted-foreground">{line}</span>
            </span>
        </>
    );
}
