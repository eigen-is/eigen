import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { EigenApp } from '@workspace/ui/components/layout/app/eigen-app.tsx';
import { mountReactApp } from '@workspace/ui/lib/mountReactApp';
import { routeTree } from './routeTree.gen';

import '@workspace/ui/globals.css';
import './../css/globals.css';

// Set up a Router instance
const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/slides',
    scrollRestoration: true,
    context: {
        auth: undefined!, // This will be set after we wrap the app in an AuthProvider
    },
});

// Register things for typesafety
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
