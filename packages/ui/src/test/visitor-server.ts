// A fake API for the editors' route tests. It answers a visitor, someone without a login, only on the routes a public
// link opens, as the API's linkAuth lists them, and 401s the rest; a signed-in user gets every route. Every request is
// recorded, so a test can say that a visitor asked for nothing more. The collab socket never opens: open() marks a
// signed-in editor's providers connected and synced, and a visitor's editor, which opens none, loads the document from
// the state route. editorVisitorTests are the tests every editor's route runs on it.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { AnyRoute } from '@tanstack/react-router';
import type * as Auth from '@workspace/lib/auth';
import type * as Collab from '@workspace/lib/collab';
import { collabStateVersion } from '@workspace/lib/collab/collab-state';
import { CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import type { AuthContextType, AuthUser } from '@workspace/lib/types/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import type { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { stubCanvasImageFonts } from './canvas-image';
import { drivePath } from './drive-path';
import { installHappyDom } from './happy-dom';
import { renderInDocument } from './render-in-document';

const VISITOR_ROUTES = [
    /^\/drive\/[^/]+\/[^/]+\/path\/[^/]+(\/breadcrumb|\/permissions)?$/,
    /^\/drive\/[^/]+\/[^/]+\/folder\/[^/]+$/,
    /^\/drive\/[^/]+\/[^/]+\/file\/[^/]+\/(download|embed\/.+|preview|text-preview|vcard-preview|eml-preview|ics-preview)$/,
    /^\/drive\/[^/]+\/[^/]+\/thumb\/.+$/,
    /^\/collab\/[^/]+\/[^/]+\/[^/]+\/(info|state)$/,
    /^\/p\//,
];

export const isVisitorRoute = (pathname: string) => VISITOR_ROUTES.some((route) => route.test(pathname));

export const OWNER = 'alice'.padEnd(32, '0');

// The signed-in user of a test, or null for a visitor; a guest is a user with that role. `viaLink` says the user reads
// the document only through its link, as someone no ACL names.
export const session: {
    user: (Pick<AuthUser, 'id' | 'email' | 'name'> & { role?: string }) | null;
    viaLink: boolean;
} = { user: null, viaLink: false };

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

// A signed-in editor's own providers, kept so open() can mark them synced and a test can read the awareness they send.
const providers = new Set<WebsocketProvider>();

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
    // The stored document, as the state route answers it.
    let stored = new Y.Doc();

    function serve(pathname: string): Response {
        if (!session.user && !isVisitorRoute(pathname))
            return Response.json({ message: 'Unauthorized' }, { status: 401 });
        const permissions = pathname.match(/\/path\/([^/]+)\/permissions$/);
        if (permissions) return Response.json({ canRead: permissions[1] === 'pub', canWrite: false });
        const info = pathname.match(/^\/collab\/[^/]+\/[^/]+\/([^/]+)\/info$/);
        if (info) {
            if (info[1] !== 'pub')
                return Response.json({
                    canRead: false,
                    canWrite: false,
                    live: false,
                    path: null,
                    folderContents: null,
                });
            // A visitor, a guest and a reader through the link read; the owner's colleague, the test's other user,
            // writes. The guest is named on the document, so only the visitor and the link's reader are not live.
            const live = !!session.user && !session.viaLink;
            const canWrite = live && session.user?.role !== 'guest';
            return Response.json({ canRead: true, canWrite, live, path: doc, folderContents: [media] });
        }
        if (/^\/collab\/[^/]+\/[^/]+\/pub\/state$/.test(pathname)) {
            return new Response(new Uint8Array(Y.encodeStateAsUpdate(stored)), {
                headers: { ETag: `"${collabStateVersion('epoch', 0, 0, 'state-f1')}"` },
            });
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
        session.viaLink = false;
    });
    afterAll(() => {
        g.fetch = realFetch;
        g.WebSocket = realWebSocket;
    });

    // The app's route tree at `url`, rendered once the document's info arrives and loaded once its providers sync or
    // its stored state arrives. `seed` writes the stored document, and into each provider's doc before it syncs.
    async function open(routeTree: AnyRoute, url: string, seed?: (doc: Y.Doc) => void) {
        stored = new Y.Doc();
        seed?.(stored);
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

const READ_ONLY = 'You can view this document';

// What an editor's route does for a visitor, a writer and a guest: read-only with no share, no activity and only the
// routes on the link's list asked, or a login with the way back for a document the link does not open.
export function editorVisitorTests({
    server,
    routeTree,
    urlOf,
    noun,
}: {
    server: ReturnType<typeof visitorServer>;
    routeTree: AnyRoute;
    urlOf: (pathId: string) => string;
    noun: string;
}) {
    const open = (url: string) => server.open(routeTree, url);

    test(`a visitor reads a public ${noun}, with its name in the bar, and asks only for what the link opens`, async () => {
        const router = await open(urlOf('pub'));
        expect(router.state.location.pathname).toBe(urlOf('pub'));
        expect(labelled(READ_ONLY)).not.toBeNull();
        expect(document.querySelector('header')?.textContent).toContain('Holiday');
        expect(labelled('Log in')).not.toBeNull();
        expect(labelled('Share')).toBeNull();
        expect(labelled('Activity')).toBeNull();
        expect(server.outsideTheLink()).toEqual([]);
        // No socket, so no presence: the document came from the state route.
        expect(providers.size).toBe(0);
        expect(server.requested).toContain(`/collab/${OWNER}/default/pub/state`);
        // The guard's read, and none from a share dialog.
        expect(server.permissionReads()).toEqual([`/drive/${OWNER}/default/path/pub/permissions`]);
    });

    test(`a search change on a public ${noun}, such as opening the comments, asks no permissions again`, async () => {
        const router = await open(urlOf('pub'));
        const { act } = await import('react');
        await act(async () => {
            await router.navigate({ href: `${urlOf('pub')}?panel=comments` });
        });
        expect(router.state.location.pathname).toBe(urlOf('pub'));
        expect(server.permissionReads()).toEqual([`/drive/${OWNER}/default/path/pub/permissions`]);
    });

    test(`a visitor lands on login, with the way back, for a ${noun} the link does not open`, async () => {
        const router = await open(urlOf('secret'));
        expect(router.state.location.pathname).toBe('/login');
        expect(router.state.location.search).toEqual({ redirect: `http://localhost:3000${urlOf('secret')}` });
    });

    test(`a signed-in writer's ${noun} is editable, offers Share and reads the comment index`, async () => {
        session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
        await open(urlOf('pub'));
        expect(labelled('Share')).not.toBeNull();
        expect(labelled('Activity')).not.toBeNull();
        expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
        expect([...providers].every((provider) => provider.awareness.getLocalState() !== null)).toBe(true);
    });

    test(`someone signed in who reads a ${noun} only through its link loads it over HTTP, with no socket`, async () => {
        session.user = { id: 'carol', email: 'carol@test.eigen.is', name: 'Carol' };
        session.viaLink = true;
        await open(urlOf('pub'));
        expect(labelled(READ_ONLY)).not.toBeNull();
        expect(providers.size).toBe(0);
        expect(server.requested).toContain(`/collab/${OWNER}/default/pub/state`);
        expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    });

    test(`a guest's ${noun} still reads the comment index and the members`, async () => {
        session.user = { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' };
        await open(urlOf('pub'));
        expect(labelled(READ_ONLY)).not.toBeNull();
        expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
        expect(server.requested).toContain(`/drive/${OWNER}/default/path/pub/effective-members`);
    });
}

// A socket that stays connecting, so y-websocket sends nothing and never reconnects.
class SilentWebSocket {
    public binaryType = 'arraybuffer';
    public readyState = 0;
    public send() {}
    public close() {}
}
