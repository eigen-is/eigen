import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlogPost } from '../../components/blog-post';
import type { ArticleMeta } from '../../content/manifest';

const post: ArticleMeta = {
    slug: 'first',
    section: 'blog',
    title: 'The first post',
    description: 'The first post',
    tags: [],
    order: 0,
    toc: [],
    related: [],
    crossSections: [],
};

describe('BlogPost', () => {
    test('the only post draws no pager', async () => {
        const router = createRouter({
            routeTree: createRootRoute({
                component: () => (
                    <QueryClientProvider client={new QueryClient()}>
                        <BlogPost post={post} body={{ html: '<p>Body</p>', mediaGrids: [] }} />
                    </QueryClientProvider>
                ),
            }),
            history: createMemoryHistory({ initialEntries: ['/blog/first'] }),
        });
        await router.load();
        expect(renderToStaticMarkup(<RouterProvider router={router} />)).not.toContain('<nav class="mt-14');
    });
});
