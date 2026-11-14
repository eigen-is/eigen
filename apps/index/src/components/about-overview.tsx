// The About overview: what eigen is, the admin's links, and a row for every app in the registry's order, with a
// still of the app, its eigen|app⟩ wordmark and one line. A row links to its app's page once that page is written,
// and each washes in its own app's color.

import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { AboutApp } from '../content/about-apps';
import { aboutApps } from '../content/about-apps';
import type { ArticleBody, ArticleMeta } from '../content/manifest';
import { AppWordmark } from './app-wordmark';
import { ArticleContent } from './article-content';
import { LandingLinks } from './landing-links';
import { ReadingLayout } from './reading-layout';
import { SitePage } from './site-page';

type AboutOverviewProps = {
    overview: ArticleMeta;
    body: ArticleBody;
    pages: readonly ArticleMeta[];
};

export function AboutOverview({ overview, body, pages }: AboutOverviewProps) {
    const written = new Set(pages.map((page) => page.slug));
    return (
        <SitePage>
            <ReadingLayout>
                <h1 className="site-title">{overview.title}</h1>
                <div className="mt-6 flex flex-wrap gap-4 empty:hidden">
                    <LandingLinks />
                </div>
                <ArticleContent body={body} className="mt-8" />
                <div className="mt-10">
                    {aboutApps.map((app, index) => {
                        const hasPage = written.has(app.slug);
                        const className = cn(
                            '-mx-(--app-gutter-x) flex items-center gap-4 px-(--app-gutter-x) py-3.5',
                            hasPage && 'eigen-list-item',
                            index > 0 && 'border-t',
                        );
                        const style = {
                            '--app-current-color': app.color,
                            '--app-current-color-soft': `color-mix(in oklab, ${app.color} 14%, var(--background))`,
                        };
                        const row = <AppRow app={app} line={overview.rows?.[app.slug]} />;
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
            </ReadingLayout>
        </SitePage>
    );
}

function AppRow({ app, line }: { app: AboutApp; line?: string }) {
    return (
        <>
            <img
                src={`/data/about/media/row-${app.slug}.webp`}
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
