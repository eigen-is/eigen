// A fake API for the editors' route tests. It answers a visitor, someone without a login, only on the routes a public
// link opens, as the API's linkAuth lists them, and 401s the rest; a signed-in user gets every route. The document it
// holds is public or private, and every request is recorded, so a test can say that a visitor asked for nothing more.
// The collab socket never opens: open() marks the editor's providers connected and synced, once a test has seeded
// their doc.

import { afterAll, afterEach, beforeEach } from 'bun:test';
import type { AnyRoute } from '@tanstack/react-router';
import type * as Auth from '@workspace/lib/auth';
import type * as Collab from '@workspace/lib/collab';
import { CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import type { AuthContextType, AuthUser } from '@workspace/lib/types/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { stubCanvasImageFonts } from './canvas-image';
import { drivePath } from './drive-path';
import { installHappyDom } from './happy-dom';
import { renderInDocument } from './render-in-document';

const VISITOR_ROUTES = [
    /^\/drive\/[^/]+\/[^/]+\/path\/[^/]+(\/breadcrumb|\/permissions)?$/,
    /^\/drive\/[^/]+\/[^/]+\/folder\/[^/]+$/,
    /^\/drive\/[^/]+\/[^/]+\/file\/[^/]+\/(download|embed\/.+|preview|text-preview|vcard-preview|eml-preview|ics-preview)$/,
    /^\/drive\/[^/]+\/[^/]+\/thumb\/.+$/,
    /^\/collab\/[^/]+\/[^/]+\/[^/]+\/info$/,
    /^\/p\//,
];

export const isVisitorRoute = (pathname: string) => VISITOR_ROUTES.some((route) => route.test(pathname));

export const OWNER = 'alice'.padEnd(32, '0');

// The signed-in user of a test, or null for a visitor; a guest is a user with that role.
export const session: { user: (Pick<AuthUser, 'id' | 'email' | 'name'> & { role?: string }) | null } = { user: null };

export function sessionAuth(): AuthContextType {
    const user = session.user && { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    return {
        isAuthenticated: !!user,
        isLoading: false,
        user,
        login: async () => ({ success: true }),
        logout: async () => {},
    };
}

export const labelled = (label: string) => document.querySelector(`[aria-label="${label}"]`);

// The auth module with the test's session in place of a login.
export function withSession(auth: typeof Auth): typeof Auth {
    return { ...auth, useAuth: sessionAuth, useIsGuest: () => session.user?.role === 'guest' };
}

// The editor's own providers, kept so open() can mark them synced and a test can read the awareness they would send.
export const providers = new Set<WebsocketProvider>();

// The collab module with every provider an editor opens kept in `providers`.
export function withProviders(collab: typeof Collab): typeof Collab {
    return {
        ...collab,
        useCollabDoc: (options) => {
            const opened = collab.useCollabDoc(options);
            if (opened.provider) providers.add(opened.provider);
            return opened;
        },
    };
}

// The public document `pub` of the given type, with its media folder, which is all a visitor's listing of it holds.
// It sets up the window the app renders into, so call it before the test's `await import(...)` lines.
export function visitorServer(document: Pick<DrivePath, 'type' | 'mimeType' | 'name'>) {
    const window = installHappyDom();
    window.happyDOM.setViewport({ width: 1440, height: 900 });
    stubCanvasImageFonts();
    const doc = drivePath({ ...document, id: 'pub', ownerId: OWNER, parentId: 'alice-root', visibility: 'link' });
    const media = drivePath({
        id: 'media',
        name: CONTAINER_MEDIA_FOLDER,
        ownerId: OWNER,
        type: 'folder',
        mimeType: DRIVE_MIME_FOLDER,
        parentId: 'pub',
    });
    const requested: string[] = [];

    function serve(pathname: string): Response {
        if (!session.user && !isVisitorRoute(pathname))
            return Response.json({ message: 'Unauthorized' }, { status: 401 });
        const permissions = pathname.match(/\/path\/([^/]+)\/permissions$/);
        if (permissions) return Response.json({ canRead: permissions[1] === 'pub', canWrite: false });
        const info = pathname.match(/^\/collab\/[^/]+\/[^/]+\/([^/]+)\/info$/);
        if (info) {
            if (info[1] !== 'pub')
                return Response.json({ canRead: false, canWrite: false, path: null, folderContents: null });
            // A visitor and a guest read; the owner's colleague, the test's other user, writes.
            const canWrite = !!session.user && session.user.role !== 'guest';
            return Response.json({ canRead: true, canWrite, path: doc, folderContents: [media] });
        }
        if (pathname.startsWith('/p/')) return Response.json({});
        if (pathname.endsWith('/unread-count')) return Response.json({ count: 0 });
        if (pathname.endsWith('/watch')) return Response.json({ direct: false, viaAncestor: null });
        return Response.json([]);
    }

    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const g = globalThis as any;
    const realFetch = g.fetch;
    const realWebSocket = g.WebSocket;
    beforeEach(() => {
        g.WebSocket = SilentWebSocket;
        requested.length = 0;
        g.fetch = async (input: string | URL | Request) => {
            const pathname = new URL(typeof input === 'object' && 'url' in input ? input.url : input).pathname;
            requested.push(pathname);
            return serve(pathname);
        };
    });
    afterEach(() => {
        providers.clear();
        session.user = null;
    });
    afterAll(() => {
        g.fetch = realFetch;
        g.WebSocket = realWebSocket;
    });

    // The app's route tree at `url`, rendered once the document's info arrives and loaded once its providers sync.
    // `seed` writes the stored document into each provider's doc before it syncs.
    async function open(routeTree: AnyRoute, url: string, seed?: (doc: Y.Doc) => void) {
        const { act, createElement } = await import('react');
        const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
        const { CommandPaletteProvider } = await import('../components/layout/app');
        const { PreviewProvider } = await import('../components/preview-provider');
        const { UploadProvider } = await import('../components/upload-provider');
        const router = createRouter({
            routeTree,
            history: createMemoryHistory({ initialEntries: [url] }),
            context: { auth: sessionAuth() },
        });
        await router.load();
        await renderInDocument(
            createElement(
                UploadProvider,
                null,
                createElement(
                    PreviewProvider,
                    null,
                    createElement(CommandPaletteProvider, null, createElement(RouterProvider, { router })),
                ),
            ),
        );
        for (let i = 0; i < 8; i++) {
            await act(async () => {
                for (const provider of providers) {
                    if (provider.synced) continue;
                    seed?.(provider.doc);
                    provider.emit('status', [{ status: 'connected' }]);
                    provider.synced = true;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            });
        }
        return router;
    }

    return {
        open,
        requested,
        outsideTheLink: () => requested.filter((pathname) => !isVisitorRoute(pathname)),
        permissionReads: () => requested.filter((pathname) => pathname.endsWith('/permissions')),
    };
}

// A socket that stays connecting, so y-websocket sends nothing and never reconnects.
class SilentWebSocket {
    public binaryType = 'arraybuffer';
    public readyState = 0;
    public send() {}
    public close() {}
}
