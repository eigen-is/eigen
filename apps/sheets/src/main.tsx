// Sheets's entry point. It builds the router over Sheets's route tree under /sheets and mounts it inside
// EigenApp, which brings the query client, auth and the other providers every app shares. It loads the
// shared app styles and Sheets' own accent color.

import { createEigenAppRouter, mountEigenApp } from '@workspace/ui/lib/eigenAppRouter';
import { routeTree } from './routeTree.gen';

import '@workspace/ui/app.css';
import './../css/globals.css';

const router = createEigenAppRouter({ routeTree, basepath: '/sheets' });

// Register things for typesafety
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

mountEigenApp(router);
