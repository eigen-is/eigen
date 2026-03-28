import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { AuthContextType } from '@workspace/lib/auth';
import { lazy, Suspense } from 'react';

const TanStackRouterDevtools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
    : () => null;

type MyRouterContext = {
    auth: AuthContextType;
};

export const Route = createRootRouteWithContext<MyRouterContext>()({
    beforeLoad: ({ context }) => {
        if (context.auth.isAuthenticated && window.location.pathname === '/') {
            window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
            return new Promise(() => {});
        }
    },
    component: () => (
        <>
            <div className="flex flex-col min-h-dvh">
                <Outlet />
            </div>
            <Suspense>
                <TanStackRouterDevtools position="bottom-right" />
            </Suspense>
        </>
    ),
});
