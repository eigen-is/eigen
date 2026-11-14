// The overview lists every app, and a row links to its app page only once that page is written.
import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutOverview } from '../../components/about-overview';
import { aboutApps } from '../../content/about-apps';
import type { ArticleMeta } from '../../content/manifest';

function meta(slug: string, extra: Partial<ArticleMeta> = {}): ArticleMeta {
    return {
        slug,
        section: 'about',
        title: slug,
        description: slug,
        tags: [],
        order: 0,
        toc: [],
        related: [],
        crossSections: [],
        ...extra,
    };
}

async function renderOverview(pages: ArticleMeta[]): Promise<string> {
    const rows = Object.fromEntries(aboutApps.map((app) => [app.slug, `The line of ${app.name}`]));
    const overview = meta('index', { title: 'About eigen', rows });
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <QueryClientProvider client={new QueryClient()}>
                    <AboutOverview overview={overview} body={{ html: '<p>Intro</p>', mediaGrids: [] }} pages={pages} />
                </QueryClientProvider>
            ),
        }),
        history: createMemoryHistory({ initialEntries: ['/about'] }),
    });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('AboutOverview', () => {
    test('draws a row per app, and links and highlights only the apps that have a page', async () => {
        const html = await renderOverview([meta('sheets')]);
        expect(html.match(/src="\/data\/about\/media\/row-[a-z]+\.webp"/g)).toHaveLength(10);
        expect(html.match(/eigen-list-item/g)).toHaveLength(1);
        expect(html.match(/<a [^>]*href="\/about\/[a-z]+"/g)).toEqual([
            expect.stringContaining('href="/about/sheets"'),
        ]);
        expect(html).toContain('The line of Contacts');
        expect(html).toContain('src="/data/about/media/row-mail.webp"');
    });
});
