// The public site's router, built once in the browser and once per page by the prerender. Its Wrap puts the
// providers every page reads around both renders, such as the session and the theme, so the two renders agree.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RouterHistory } from '@tanstack/react-router';
import { createRouter } from '@tanstack/react-router';
import { AuthProvider } from '@workspace/lib/auth';
import { ThemeProvider } from '@workspace/ui/components/layout/app';
import type { ReactNode } from 'react';
import { SITE_SCROLL_ID } from './components/site-page';
import { routeTree } from './routeTree.gen';

export function createAppRouter(history?: RouterHistory) {
    const queryClient = new QueryClient();
    return createRouter({
        routeTree,
        ...(history ? { history } : {}),
        basepath: '/',
        defaultPreload: 'intent',
        scrollRestoration: true,
        // The page scrolls smoothly for its own links, but a new page opens at its top at once.
        scrollToTopSelectors: [`#${SITE_SCROLL_ID}`],
        scrollRestorationBehavior: 'instant',
        Wrap: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>
                <AuthProvider>
                    <ThemeProvider>{children}</ThemeProvider>
                </AuthProvider>
            </QueryClientProvider>
        ),
    });
}

declare module '@tanstack/react-router' {
    interface Register {
        router: ReturnType<typeof createAppRouter>;
    }
}
