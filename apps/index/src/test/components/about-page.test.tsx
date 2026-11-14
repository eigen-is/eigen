import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutPage } from '../../components/about-page';
import { aboutApps } from '../../content/about-apps';
import type { ArticleMeta } from '../../content/manifest';

function aboutMeta(slug: string): ArticleMeta {
    return {
        slug,
        section: 'about',
        title: `About ${slug}`,
        description: `What ${slug} does`,
        tags: [],
        order: 0,
        toc: [],
        related: [],
        crossSections: [],
    };
}

async function renderPage(previous?: ArticleMeta, next?: ArticleMeta, slug = 'mail'): Promise<string> {
    const app = aboutApps.find((entry) => entry.slug === slug);
    if (!app) throw new Error(`No app ${slug}`);
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <QueryClientProvider client={new QueryClient()}>
                    <AboutPage
                        app={app}
                        page={aboutMeta(app.slug)}
                        body={{ html: '<p>Body</p><p>[BLOCK:formats]</p>', mediaGrids: [] }}
                        previous={previous}
                        next={next}
                    />
                </QueryClientProvider>
            ),
        }),
        history: createMemoryHistory({ initialEntries: [`/about/${app.slug}`] }),
    });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('AboutPage', () => {
    test('a lone page draws no pager', async () => {
        expect(await renderPage()).not.toContain('<nav class="mt-14');
    });

    test('a page with a next page links it', async () => {
        expect(await renderPage(undefined, aboutMeta('docs'))).toContain('href="/about/docs"');
    });

    test('an app that opens and saves open formats shows them in a panel, with the article that explains it', async () => {
        const html = await renderPage(undefined, undefined, 'sheets');
        expect(html).toContain('Open, and yours to take');
        expect(html).toContain('>.xlsx</span>');
        expect(html).toContain('href="/support/sheets/import-excel"');
    });

    test('an app with nothing to take out shows no such panel', async () => {
        expect(await renderPage(undefined, undefined, 'chat')).not.toContain('Open, and yours to take');
    });
});
