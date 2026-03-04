import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useAuth} from '@workspace/lib/auth';
import {EigenApp} from '@workspace/ui';
import {routeTree} from './routeTree.gen';
import '@workspace/ui/styles/globals.css';
import '../css/globals.css';

const queryClient = new QueryClient();

const router = createRouter({
    routeTree,
    basepath: '/slides',
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
    return <RouterProvider router={router} context={{auth}}/>;
}

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <EigenApp>
                <InnerApp/>
            </EigenApp>
        </QueryClientProvider>
    );
}

const rootElement = document.getElementById('root')!;
if (!rootElement.innerHTML) {
    const root = createRoot(rootElement);
    root.render(
        <StrictMode>
            <App/>
        </StrictMode>,
    );
}
