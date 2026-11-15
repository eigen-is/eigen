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
                        body={{ html: '<p>Body</p><p>[BLOCK:app-principles]</p>', media: [] }}
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

    test('an app page shows its principles in the gutter, and again at the end of the body for narrow screens', async () => {
        const html = await renderPage();
        const [gutter, column] = html.split('site-reading-column');
        for (const part of [gutter, column]) {
            expect(part.match(/Use your apps/g)?.length).toBe(1);
            expect(part.match(/Data sovereignty/g)?.length).toBe(1);
            expect(part).not.toContain('Office compatible');
            expect(part).not.toContain('>IMAP</span>');
            expect(part).toContain('Every message is a plain .eml file.');
            expect(part).toContain('href="/support/mail/download-an-email"');
        }
    });

    test('an app with no principles shows no boxes', async () => {
        const html = await renderPage(undefined, undefined, 'chat');
        expect(html).not.toContain('Use your apps');
        expect(html).not.toContain('Data sovereignty');
        expect(html).not.toContain('data-slot="badge"');
    });

    test("an app page links its whole help section under the boxes, and again at the body's end", async () => {
        const [gutter, column] = (await renderPage()).split('site-reading-column');
        for (const part of [gutter, column]) {
            expect(part.match(/href="\/support\/mail"/g)?.length).toBe(1);
            expect(part).toContain('All Mail help articles');
        }
    });

    test('an app with no principles still links its help section', async () => {
        const [gutter, column] = (await renderPage(undefined, undefined, 'chat')).split('site-reading-column');
        for (const part of [gutter, column]) {
            expect(part.match(/href="\/support\/chat"/g)?.length).toBe(1);
            expect(part).toContain('All Chat help articles');
        }
    });

    test('the body has no formats panel', async () => {
        expect(await renderPage(undefined, undefined, 'sheets')).not.toContain('Open, and yours to take');
    });
});
