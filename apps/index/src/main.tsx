import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import '@workspace/ui/globals.css';
import './../css/globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@workspace/lib/auth';
import { Toaster } from '@workspace/ui/components/sonner';
import { mountReactApp } from '@workspace/ui/lib/mountReactApp';

const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/',
    scrollRestoration: true,
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

const queryClient = new QueryClient();

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <Toaster />
                <RouterProvider router={router} />
            </AuthProvider>
        </QueryClientProvider>
    );
}

mountReactApp('app', <App />);
