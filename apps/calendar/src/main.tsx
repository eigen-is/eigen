import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { EigenApp } from '@workspace/ui/components/layout/app/eigen-app.tsx';
import { mountReactApp } from '@workspace/ui/lib/mountReactApp';
import { routeTree } from './routeTree.gen';

import '@workspace/ui/globals.css';
import './../css/globals.css';

const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/calendar',
    scrollRestoration: true,
    context: {
        auth: undefined!,
    },
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

function InnerApp() {
    const auth = useAuth();
    return <RouterProvider router={router} context={{ auth }} />;
}

function App() {
    return (
        <EigenApp>
            <InnerApp />
        </EigenApp>
    );
}

mountReactApp('app', <App />);
