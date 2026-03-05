import ReactDOM from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import {useAuth} from '@workspace/lib/auth';
import {EigenApp} from '@workspace/ui/components/layout/app/eigen-app.tsx';

import '@workspace/ui/globals.css';
import './../css/globals.css';

const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/people',
    scrollRestoration: true,
    context: {
        auth: undefined!,
    },
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

function InnerApp() {
    const auth = useAuth();
    return <RouterProvider router={router} context={{auth}}/>;
}

function App() {
    return (
        <EigenApp>
            <InnerApp/>
        </EigenApp>
    );
}

const rootElement = document.getElementById('app')!;

if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App/>);
}
