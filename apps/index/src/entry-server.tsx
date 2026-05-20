import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { routeTree } from './routeTree.gen';

// SSR entry — renders one route to an HTML string. Loaded by scripts/prerender.tsx
// through Vite's ssrLoadModule, so the route tree's Vite-only APIs (the content
// loader's import.meta.glob, the app-URL import.meta.env values) resolve correctly.
export async function render(url: string): Promise<string> {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth: undefined! },
    });
    await router.load();
    return renderToString(<RouterProvider router={router} />);
}
