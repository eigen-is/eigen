import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { AuthProvider } from '@workspace/lib/auth';
import { renderToString } from 'react-dom/server';
import { type PageArticle, setPrerenderBody } from './content/manifest';
import { routeTree } from './routeTree.gen';

// SSR entry — renders one route to an HTML string. Loaded by scripts/prerender.tsx
// through Vite's ssrLoadModule. The auth + query providers are required because
// the unified Topbar (used by /support and /blog) calls useAuth and TanStack Query
// hooks. `article` is the page's own body — the prerender hands it in so the route
// component can render it synchronously (the server has no DOM to read it from).
export async function render(url: string, article: PageArticle | null): Promise<string> {
    setPrerenderBody(article);
    const queryClient = new QueryClient();
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth: undefined! },
    });
    await router.load();
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <RouterProvider router={router} />
            </AuthProvider>
        </QueryClientProvider>,
    );
}
