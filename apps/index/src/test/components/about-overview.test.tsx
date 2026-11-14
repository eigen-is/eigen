import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutOverview } from '../../components/about-overview';
import { aboutApps } from '../../content/about-apps';
import type { ArticleMeta } from '../../content/manifest';

async function renderOverview(): Promise<string> {
    const overview: ArticleMeta = {
        slug: 'index',
        section: 'about',
        title: 'About eigen',
        description: 'About eigen',
        tags: [],
        order: 0,
        rows: Object.fromEntries(aboutApps.map((app) => [app.slug, `The line of ${app.name}`])),
        toc: [],
        related: [],
        crossSections: [],
    };
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <QueryClientProvider client={new QueryClient()}>
                    <AboutOverview
                        overview={overview}
                        body={{ html: '<p>Intro</p><p>[BLOCK:apps]</p>', mediaGrids: [] }}
                    />
                </QueryClientProvider>
            ),
        }),
        history: createMemoryHistory({ initialEntries: ['/about'] }),
    });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('AboutOverview', () => {
    test('draws a row per app at the apps block of the body, and links and highlights only the apps that have a page', async () => {
        const html = await renderOverview();
        expect(html.match(/src="\/data\/about\/media\/row-[a-z]+\.webp"/g)).toHaveLength(10);
        expect(html.match(/eigen-list-item/g)).toHaveLength(3);
        expect(html.match(/<a [^>]*href="\/about\/[a-z]+"/g)).toEqual([
            expect.stringContaining('href="/about/docs"'),
            expect.stringContaining('href="/about/sheets"'),
            expect.stringContaining('href="/about/slides"'),
        ]);
        expect(html).toContain('The line of Contacts');
        expect(html).toContain('src="/data/about/media/row-mail.webp"');
    });
});
