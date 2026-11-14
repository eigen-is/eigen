// Vector's entry point. It builds the router over Vector's route tree under /vector and mounts it inside
// EigenApp, which brings the query client, auth and the other providers every app shares. It loads the
// shared app styles and Vector's own accent color.

import { createEigenAppRouter, mountEigenApp } from '@workspace/ui/lib/eigenAppRouter';
import { routeTree } from './routeTree.gen';

import '@workspace/ui/app.css';
import './../css/globals.css';

const router = createEigenAppRouter({ routeTree, basepath: '/vector' });

// Register things for typesafety
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

mountEigenApp(router);
