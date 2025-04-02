import ReactDOM from 'react-dom/client';
import {createRouter} from '@tanstack/react-router';
import {routeTree} from './routeTree.gen';
import '@workspace/ui/globals.css';
import {HomeComponent} from "@/routes";
import {Toaster} from '@workspace/ui/components/sonner';

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

function App() {
    return (
        <>
            <Toaster/>
            <HomeComponent/>
        </>
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