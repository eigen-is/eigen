import '@workspace/ui/globals.css';
import './../css/globals.css';
import { RouterClient } from '@tanstack/react-router/ssr/client';
import { Toaster } from '@workspace/ui/components/sonner';
import { mountReactApp } from '@workspace/ui/lib/mountReactApp';
import { useEffect, useState } from 'react';
import { createAppRouter } from './router';

const router = createAppRouter();

function App() {
    // The Toaster is client-only — rendering it on the first (hydration) render
    // would add a Sonner <section> the prerendered HTML lacks, a mismatch (#418)
    // that makes React discard the SSR DOM. Mount it after hydration so the first
    // client render matches the server-rendered markup.
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);

    // RouterClient suspends until hydrate(router) resolves (reading the dehydrated
    // state the SSR <script> put on window.$_TSR), then renders RouterProvider —
    // reproducing the server's Suspense boundary so hydration matches in place.
    // The query + auth providers are supplied by the router's Wrap, on both server
    // and client, so the two renders agree.
    return (
        <>
            {hydrated && <Toaster />}
            <RouterClient router={router} />
        </>
    );
}

mountReactApp('app', <App />);
