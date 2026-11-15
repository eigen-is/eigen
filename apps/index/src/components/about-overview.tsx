// The About overview: what eigen is, the admin's links, and the body, with the landing page's blocks on what Eigen
// stands for where its `::: principles` block stands, and where its `::: apps` block stands a row for every app in
// the registry's order, with a still of the app, its eigen|app⟩ wordmark and one line. A row links to its app's page
// once that page is written, and each washes in its own app's color.

import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { AboutApp } from '../content/about-apps';
import { aboutApps } from '../content/about-apps';
import { aboutRowStill } from '../content/about-media';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
import { getAboutArticles } from '../content/manifest';
import { AppWordmark } from './app-wordmark';
import { ArticleContent } from './article-content';
import { PrincipleBlocks } from './landing-blocks';
import { LandingLinks } from './landing-links';
import { SitePage } from './site-page';

type AboutOverviewProps = {
    overview: ArticleMeta;
    body: ArticleBody;
};

export function AboutOverview({ overview, body }: AboutOverviewProps) {
    return (
        <SitePage>
            <div className="site-wide py-12">
                <h1 className="site-title">{overview.title}</h1>
                <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                    <LandingLinks />
                </div>
                <ArticleContent
                    body={body}
                    blocks={{
                        principles: <PrincipleBlocks className="my-8 md:gap-4" />,
                        apps: <AppRows rows={overview.rows} />,
                    }}
                    className="mt-8"
                />
            </div>
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
