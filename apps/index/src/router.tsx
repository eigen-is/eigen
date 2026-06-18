import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { AuthProvider } from '@workspace/lib/auth';
import type { ReactNode } from 'react';
import { routeTree } from './routeTree.gen';

export function createAppRouter(history?: RouterHistory) {
    const queryClient = new QueryClient();
    return createRouter({
        routeTree,
        ...(history ? { history } : {}),
        basepath: '/',
        defaultPreload: 'intent',
        scrollRestoration: true,
        Wrap: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>
                <AuthProvider>{children}</AuthProvider>
            </QueryClientProvider>
        ),
    });
}

declare module '@tanstack/react-router' {
    interface Register {
        router: ReturnType<typeof createAppRouter>;
    }
}
