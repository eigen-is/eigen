// Every Eigen app, such as Drive, Mail or Docs, boots the same way: a TanStack router with the same defaults over the
// app's own route tree, mounted inside the shared EigenApp providers. So an app's main.tsx holds only its route tree,
// the router constant its `Register` declaration needs, and the mount call. The Index app renders with SSR and is not
// built on these.

import type { AnyRoute, AnyRouter } from '@tanstack/react-router';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { EigenApp } from '../components/layout/app/eigen-app';
import { EmptyState } from '../components/layout/app/empty-state';
import { mountReactApp } from './mountReactApp';

export function createEigenAppRouter<TRouteTree extends AnyRoute>(options: {
    routeTree: TRouteTree;
    basepath: string;
}) {
    // The router asks once per render. A scroll belongs to its page, so a change of only the search, such as a detail
    // column's ?chat=, leaves every scroll box alone: putting one back would stop a scroll under way, such as a jump.
    let shownPath: string | undefined;
    return createRouter({
        routeTree: options.routeTree,
        defaultPreload: 'intent',
        basepath: options.basepath,
        scrollRestoration: ({ location }) => {
            const pathChanged = location.pathname !== shownPath;
            shownPath = location.pathname;
            return pathChanged;
        },
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
