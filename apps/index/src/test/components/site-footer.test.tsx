// The footer links the About overview on every page, in the prerendered HTML, before any config has loaded.
import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteFooter } from '../../components/site-footer';

describe('SiteFooter', () => {
    test('links the About overview first', async () => {
        const router = createRouter({
            routeTree: createRootRoute({
                component: () => (
                    <QueryClientProvider client={new QueryClient()}>
                        <SiteFooter />
                    </QueryClientProvider>
                ),
            }),
            history: createMemoryHistory({ initialEntries: ['/'] }),
        });
        await router.load();
        const html = renderToStaticMarkup(<RouterProvider router={router} />);
        expect(html.match(/<nav[^>]*><a [^>]*href="([^"]+)"[^>]*>([^<]+)</)?.slice(1)).toEqual(['/about', 'About']);
    });
});
