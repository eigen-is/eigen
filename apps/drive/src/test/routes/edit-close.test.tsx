// Closing a text file returns to its folder, or to Shared with me when the file was shared on its own and
// the viewer can't read that folder (the file then heads its own breadcrumb chain).
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

// The route's data, stubbed: one object per hook, so the component's effects see stable data across renders.
const session = { user: { id: 'owner-1', email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }) };
const file = drivePath({
    id: 'file-1',
    parentId: 'folder-1',
    mountId: 'mount-1',
    name: 'notes.md',
    mimeType: 'text/markdown',
});
const pathInfo = { data: file };
const breadcrumb: { data: { id: string }[] } = { data: [] };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realEditor = { ...(await import('../../components/editor/native-file-editor')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    usePathInfo: () => pathInfo,
    useBreadcrumb: () => breadcrumb,
}));
// The viewer is tested on its own; here it is the Close button the route hands its onClose to.
mock.module('../../components/editor/native-file-editor', () => ({
    ...realEditor,
    NativeFileEditor: ({ onClose }: { onClose: () => void }) => (
        <button type="button" onClick={onClose}>
            Close
        </button>
    ),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('../../components/editor/native-file-editor', () => realEditor);
});

const { act } = await import('react');
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

// Opens the file, clicks Close, and answers where the app went.
async function closeFile(): Promise<string> {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/edit/owner-1/mount-1/file-1'] }),
        context: { auth },
    });
    await router.load();
    // Drive's New menu, its previews and its palette actions go through the providers every app mounts.
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
    const close = [...rendered.container.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    if (!close) throw new Error('the edit route rendered no viewer');
    await act(async () => close.click());
    return router.state.location.pathname;
}

test('closing a file in a readable folder goes to that folder', async () => {
    breadcrumb.data = [{ id: 'folder-1' }, { id: 'file-1' }];
    expect(await closeFile()).toBe('/fs/owner-1/mount-1/folder-1');
});

test('closing a file shared on its own goes to Shared with me', async () => {
    breadcrumb.data = [{ id: 'file-1' }];
    expect(await closeFile()).toBe('/shared/with-me');
});
