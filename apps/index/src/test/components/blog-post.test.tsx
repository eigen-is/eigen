import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { ArticleMeta } from '../../content/manifest';

installHappyDom();

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { renderToStaticMarkup } = await import('react-dom/server');
const { BlogPost } = await import('../../components/blog-post');

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
                        <BlogPost post={post} body={{ html: '<p>Body</p>', media: [] }} />
                    </QueryClientProvider>
                ),
            }),
            history: createMemoryHistory({ initialEntries: ['/blog/first'] }),
        });
        await router.load();
        expect(renderToStaticMarkup(<RouterProvider router={router} />)).not.toContain('<nav class="mt-14');
    });
});
