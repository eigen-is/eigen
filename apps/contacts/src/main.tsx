import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { EigenApp } from '@workspace/ui/components/layout/app/eigen-app.tsx';
import ReactDOM from 'react-dom/client';
import { routeTree } from './routeTree.gen';

import '@workspace/ui/globals.css';
import './../css/globals.css';

// Set up a Router instance
const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/contacts',
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

function App() {
    const auth = useAuth();
    return (
        <EigenApp>
            <RouterProvider router={router} context={{ auth }} />
        </EigenApp>
    );
}

const rootElement = document.getElementById('app')!;

if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
}
