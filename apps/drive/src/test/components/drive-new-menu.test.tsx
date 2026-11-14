// The sidebar's New creates into the folder that is open. In a folder shared with the viewer to view only, it is
// greyed out, as every other write there is; a folder they may edit, or their own, keeps it.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });

const ME = 'new-menu-viewer';
const SHARER = 'new-menu-sharer';

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: ME, email: 'me@test.eigen.is', name: 'Me' } };
const root = {
    data: drivePath({ id: 'my-root', ownerId: ME, name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }),
};
const sharedFolder = {
    data: drivePath({ id: 'shared', ownerId: SHARER, name: 'Shared', type: 'folder', mimeType: 'inode/directory' }),
    isLoading: false,
};
const folderContent = { data: [], isLoading: false, error: null };
const permissions = { canWrite: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    useFolderContent: () => folderContent,
    usePathInfo: () => sharedFolder,
    useCanWriteFolder: (ownerId: string) => ownerId === ME || permissions.canWrite,
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

async function newButton(ownerId: string, canWrite: boolean): Promise<HTMLButtonElement | undefined> {
    permissions.canWrite = canWrite;
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [`/fs/${ownerId}/default/shared`] }),
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
    return [...rendered.container.querySelectorAll('button')].find((button) => button.textContent === 'New');
}

test('New is greyed out in a folder shared to view only', async () => {
    expect((await newButton(SHARER, false))?.disabled).toBe(true);
});

test('New stays in a shared folder the viewer may edit', async () => {
    expect((await newButton(SHARER, true))?.disabled).toBe(false);
});

test("New stays in the viewer's own folder", async () => {
    expect((await newButton(ME, false))?.disabled).toBe(false);
});
