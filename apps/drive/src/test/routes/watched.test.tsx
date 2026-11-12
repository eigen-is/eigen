// Watched lists what the viewer watches. A list that failed to load shows the standard error text alone,
// instead of claiming there is nothing watched yet, and an empty one shows the standard empty text.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });
// happy-dom lays nothing out, so the list's virtualizer would see a scroller 0 px tall and draw no row. The
// window is this file's own, so the stub goes with it.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 900 });

const OWNER = 'watched-owner';

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: OWNER, email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }) };
const watches: { data: DrivePath[] | undefined; isLoading: boolean; error: Error | null } = {
    data: [],
    isLoading: false,
    error: null,
};
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    useTrash: () => ({ items: [], isLoading: false, error: null }),
    useAllWatches: () => watches,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import('@workspace/ui/components/layout/app');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    watches.data = [];
    watches.error = null;
});

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/watched'] }),
        context: { auth },
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
    return rendered.container;
}

test('a Watched list that failed to load shows the null vector, with no detail and no empty text', async () => {
    watches.data = undefined;
    watches.error = new Error('The server is unreachable');
    const container = await open();
    expect(container.textContent).toContain('Encountering the null vector: a rendezvous with nothing at all.');
    expect(container.textContent).not.toContain('The server is unreachable');
    expect(container.textContent).not.toContain('Within this void, all possibilities are yet unobserved.');
});

test('an empty Watched shows the standard empty text', async () => {
    const container = await open();
    expect(container.textContent).toContain('Within this void, all possibilities are yet unobserved.');
});
