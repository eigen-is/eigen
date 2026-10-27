// The trash lists what was deleted, and "Modified" sorts it by when each item was trashed, not by its last
// edit. Empty trash shows only when there is something to empty, and asks before it deletes everything.
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
// The view preferences this user keeps: newest first by "Modified".
window.localStorage.setItem(
    'eigen-drive-view:trash-owner',
    JSON.stringify({ mode: 'list', sortKey: 'modified', sortDir: 'desc' }),
);

const trashed = (name: string, editedDay: number, trashedDay: number): DrivePath =>
    drivePath({
        id: name,
        name,
        ownerId: 'trash-owner',
        mimeType: 'text/plain',
        updatedAt: new Date(Date.UTC(2026, 9, editedDay)),
        trashedAt: new Date(Date.UTC(2026, 9, trashedDay)),
    });

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: 'trash-owner', email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }) };
const trash: { data: DrivePath[]; isLoading: boolean } = { data: [], isLoading: false };
const emptyTrash = { mutateAsync: mock(async () => {}), isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    useListTrash: () => trash,
    useEmptyTrash: () => emptyTrash,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
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
beforeEach(() => {
    trash.data = [];
    trash.isLoading = false;
    emptyTrash.mutateAsync.mockClear();
});

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/trash'] }),
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
    return rendered.container;
}

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const buttonLabels = (root: ParentNode) => [...root.querySelectorAll('button')].map((b) => b.textContent?.trim());
const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
// The names the list's rows show, in their order.
const names = (container: HTMLElement, all: string[]) =>
    [...container.querySelectorAll('[role="grid"] [data-index]')].map((row) =>
        all.find((name) => row.textContent?.includes(name)),
    );

test('the trash sorts newest trashed first, whatever was edited last', async () => {
    trash.data = [trashed('old-edit.txt', 1, 20), trashed('new-edit.txt', 25, 10), trashed('middle.txt', 5, 15)];
    const container = await open();
    expect(names(container, ['old-edit.txt', 'new-edit.txt', 'middle.txt'])).toEqual([
        'old-edit.txt',
        'middle.txt',
        'new-edit.txt',
    ]);
});

test('an empty trash says so and offers nothing to empty', async () => {
    const container = await open();
    expect(container.textContent).toContain('Trash is empty');
    expect(buttonLabels(container)).not.toContain('Empty trash');
});

test('Empty trash asks first, then deletes everything', async () => {
    trash.data = [trashed('a.txt', 1, 2)];
    const container = await open();
    await click(button(container, 'Empty trash'));
    expect(emptyTrash.mutateAsync).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain('permanently delete all items in trash');
    await click(dialog && button(dialog, 'Empty trash'));
    expect(emptyTrash.mutateAsync).toHaveBeenCalledTimes(1);
});

test('while the trash loads it claims nothing', async () => {
    trash.isLoading = true;
    const container = await open();
    expect(container.textContent).not.toContain('Trash is empty');
    expect(buttonLabels(container)).not.toContain('Empty trash');
});
