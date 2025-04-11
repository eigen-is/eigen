import ReactDOM from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import '@workspace/ui/globals.css';
import {Toaster} from '@workspace/ui/components/sonner';
import {AuthProvider, useAuth} from '@workspace/lib/auth/auth-context.tsx';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';

// Set up a Router instance
const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/',
    scrollRestoration: true,
    context: {
        auth: undefined!, // This will be set after we wrap the app in an AuthProvider
    },
});

// Register things for typesafety
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

function InnerApp() {
    const auth = useAuth()
    return <RouterProvider router={router} context={{auth}}/>
}

function App() {
    const queryClient = new QueryClient();
    return (
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <Toaster/>
                <InnerApp/>
            </AuthProvider>
        </QueryClientProvider>
    )
}


// Register things for typesafety
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App/>);
}