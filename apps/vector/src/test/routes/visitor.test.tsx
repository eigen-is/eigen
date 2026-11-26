// A visitor is someone without a login who opened a public link. The vector route renders for them over the real route
// tree and editor, against a server that answers only the routes a public link opens: read-only, with no share, no
// activity and only the routes on that list asked. A private drawing sends them to log in with the way back, and a
// signed-in user's and a guest's editor still read the comment index the visitor never asks for.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_VECTOR } from '@workspace/lib/types/drive';
import { stubCanvasImageFonts } from '@workspace/ui/test/canvas-image';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { OWNER, session, sessionAuth, visitorServer } from '@workspace/ui/test/visitor-server';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });
stubCanvasImageFonts();

const server = visitorServer({ type: 'vector', mimeType: DRIVE_MIME_VECTOR, name: 'Holiday.eigenvector' });

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCollab = { ...(await import('@workspace/lib/collab')) };
// The editor's own provider, kept so a test can mark it synced and read the awareness it would send.
type Provider = NonNullable<ReturnType<typeof realCollab.useCollabDoc>['provider']>;
const providers = new Set<Provider>();
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: Parameters<typeof realCollab.useCollabDoc>[0]) => {
        const collab = realCollab.useCollabDoc(options);
        if (collab.provider) providers.add(collab.provider);
        return collab;
    },
}));
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => sessionAuth(),
    useIsGuest: () => session.user?.role === 'guest',
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import('@workspace/ui/components/layout/app');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    providers.clear();
    session.user = null;
});

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth: sessionAuth() },
    });
    await router.load();
    const rendered = await renderInDocument(
        <UploadProvider>
            <PreviewProvider>
                <CommandPaletteProvider>
                    <RouterProvider router={router} />
                </CommandPaletteProvider>
            </PreviewProvider>
        </UploadProvider>,
    );
    unmount = rendered.unmount;
    // The editor mounts once the document's info arrives, and loads once its provider syncs.
    for (let i = 0; i < 8; i++) {
        await act(async () => {
            for (const provider of providers) provider.synced = true;
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
    }
    return { container: rendered.container, router };
}

const URL_OF = (pathId: string) => `/vector/${OWNER}/default/${pathId}`;
const labelled = (label: string) => document.querySelector(`[aria-label="${label}"]`);
const READ_ONLY = "You can only read this document because you're set to Viewer";

test('a visitor reads a public drawing, with its name in the bar, and asks only for what the link opens', async () => {
    const { router } = await open(URL_OF('pub'));
    expect(router.state.location.pathname).toBe(URL_OF('pub'));
    expect(labelled(READ_ONLY)).not.toBeNull();
    expect(document.querySelector('header')?.textContent).toContain('Holiday');
    expect(labelled('Log in')).not.toBeNull();
    expect(labelled('Share')).toBeNull();
    expect(labelled('Activity')).toBeNull();
    expect(server.outsideTheLink()).toEqual([]);
    // No presence: with no local state y-websocket sends no awareness, and a cursor set later does nothing.
    expect([...providers].map((provider) => provider.awareness.getLocalState())).toEqual([null]);
    // The guard's read, and none from a share dialog.
    expect(server.permissionReads()).toEqual([`/drive/${OWNER}/default/path/pub/permissions`]);
});

test('a visitor lands on login, with the way back, for a drawing the link does not open', async () => {
    const { router } = await open(URL_OF('secret'));
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: URL_OF('secret') });
});

test("a signed-in writer's drawing is editable, offers Share and reads the comment index", async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    await open(URL_OF('pub'));
    expect(labelled('Share')).not.toBeNull();
    expect(labelled('Activity')).not.toBeNull();
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect([...providers].every((provider) => provider.awareness.getLocalState() !== null)).toBe(true);
});

test("a guest's drawing still reads the comment index and the members", async () => {
    session.user = { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' };
    await open(URL_OF('pub'));
    expect(labelled(READ_ONLY)).not.toBeNull();
    expect(server.requested).toContain(`/collab/${OWNER}/default/pub/comments`);
    expect(server.requested).toContain(`/drive/${OWNER}/default/path/pub/effective-members`);
});
