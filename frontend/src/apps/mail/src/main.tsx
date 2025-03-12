import ReactDOM from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import "./lib/auth/auth-client";
import {AuthProvider, useAuth} from "@/lib/auth/auth-context.tsx";
import {authClient} from "@/lib/auth/auth-client.ts";
import {api} from "@/lib/api.ts";

// Set up a Router instance
const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    basepath: '/mail',
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
    return (
        <AuthProvider>
            <InnerApp/>
        </AuthProvider>
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

const session = await authClient.getSession();

if (session) {
    api.index.get().then(console.log).catch(console.error);
    api.mail.mailboxes.get().then(console.log).catch(console.error);
    // @ts-ignore
    api.mail.mailbox['[Eigen]/Spam'].get().then(console.log).catch(console.error);
}