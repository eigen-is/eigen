import type { AnyRoute, AnyRouter } from '@tanstack/react-router';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { EigenApp } from '../components/layout/app/eigen-app.tsx';
import { EmptyState } from '../components/layout/app/empty-state.tsx';
import { mountReactApp } from './mountReactApp.ts';

// Every Eigen SPA (drive, mail, docs, …) boots the same way: a TanStack router
// with identical defaults over the app's own route tree, mounted inside the
// shared <EigenApp> provider stack. These two helpers own that shape so each
// app's main.tsx is just its route tree, the local router constant it still
// needs for the `Register` type declaration, and the mount call. The Index app
// is deliberately not built on these; it renders with SSR/hydration.

// `basepath` is the only thing that differs between apps.
export function createEigenAppRouter<TRouteTree extends AnyRoute>(options: {
    routeTree: TRouteTree;
    basepath: string;
}) {
    return createRouter({
        routeTree: options.routeTree,
        defaultPreload: 'intent',
        basepath: options.basepath,
        scrollRestoration: true,
        // A mistyped URL lands on the house empty state, not TanStack's bare default page.
        defaultNotFoundComponent: () => <EmptyState message="This page could not be found." />,
        context: {
            auth: undefined!, // Set after we wrap the app in an AuthProvider.
        },
    });
}

export function mountEigenApp(router: AnyRouter): void {
    // The router context is filled in from inside the tree so it reads the live
    // auth session from the AuthProvider that <EigenApp> renders above it.
    function InnerApp() {
        const auth = useAuth();
        return <RouterProvider router={router} context={{ auth }} />;
    }

    mountReactApp(
        'app',
        <EigenApp>
            <InnerApp />
        </EigenApp>,
    );
}
