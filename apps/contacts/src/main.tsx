import ReactDOM from 'react-dom/client';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import {AuthProvider, useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {authClient} from "@workspace/lib/auth/auth-client.ts";

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

// const session = await authClient.getSession();
//
// if (session) {
//     api.index.get().then(console.log);
//     api.mail.mailboxes.get().then(console.log);
//     // @ts-ignore
//     api.mail.mailbox['[Eigen]/Spam'].get();
// }
authClient.signUp.email({
    email: 'reinder@eigen.is',
    password: 'password',
    name: 'Reinder'
})
authClient.signUp.email({
    email: 'mark@eigen.is',
    password: 'password',
    name: 'Mark'
})