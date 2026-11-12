// The trash lists what was deleted, and "Modified" sorts it by when each item was trashed, not by its last
// edit. An empty or failed trash shows the standard text. Empty trash shows only when there is something to
// empty, and asks before it deletes everything.
// A trashed row's menu and the command palette offer the same two rows: Restore and Delete permanently.
// When Delete permanently gets only part of a selection through, the dialog stays open on the items that
// failed, and confirming again sends only those.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';
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
const trash: { data: DrivePath[] | undefined; isLoading: boolean; error: Error | null } = {
    data: [],
    isLoading: false,
    error: null,
};
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
const { useCommandPalette } = await import('@workspace/lib/command-palette');
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

// What the page hands the command palette, read beside it.
const palette: { actions: PaletteSelectionActions } = { actions: null };
function PaletteReader() {
    palette.actions = useCommandPalette().selectionActions;
    return null;
}

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    trash.data = [];
    trash.isLoading = false;
    trash.error = null;
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
                    <PaletteReader />
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

test('an empty trash shows the standard empty text and offers nothing to empty', async () => {
    const container = await open();
    expect(container.textContent).toContain('Within this void, all possibilities are yet unobserved.');
    expect(buttonLabels(container)).not.toContain('Empty trash');
});

test('a trash that failed to load shows the null vector, with no detail and no empty text', async () => {
    trash.data = undefined;
    trash.error = new Error('The server is unreachable');
    const container = await open();
    expect(container.textContent).toContain('Encountering the null vector: a rendezvous with nothing at all.');
    expect(container.textContent).not.toContain('The server is unreachable');
    expect(container.textContent).not.toContain('Within this void, all possibilities are yet unobserved.');
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
    expect(container.textContent).not.toContain('Within this void, all possibilities are yet unobserved.');
    expect(buttonLabels(container)).not.toContain('Empty trash');
});

test('the palette offers a trashed item only Restore and Delete permanently', async () => {
    trash.data = [trashed('a.txt', 1, 2)];
    const container = await open();
    await click(container.querySelector('[role="grid"] [data-index] > *'));
    expect(palette.actions?.map(({ action }) => action.label)).toEqual(['Restore', 'Delete permanently']);
});

test('a trashed row’s menu draws the same rows, Delete permanently last and red', async () => {
    trash.data = [trashed('a.txt', 1, 2)];
    const container = await open();
    await act(async () => {
        container
            .querySelector('[role="grid"] [data-index] > *')
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(menuRows()).toEqual(['Restore', '—', 'Delete permanently']);
    const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(rows.map((row) => row.getAttribute('data-variant'))).toEqual(['default', 'destructive']);
});

test('confirming Delete permanently again after a partial failure sends only the refused item', async () => {
    // The trash ids the delete route was asked for, in order. The server refuses `b.txt`.
    const deleted: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const g = globalThis as any;
    const realFetch = g.fetch;
    g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const id = /\/trash\/([^/]+)$/.exec(url)?.[1];
        if (!id || init?.method !== 'DELETE') return realFetch(input, init);
        deleted.push(decodeURIComponent(id));
        if (id === 'b.txt') return new Response('No access', { status: 403 });
        return Response.json({ success: true });
    };
    try {
        trash.data = [trashed('a.txt', 1, 3), trashed('b.txt', 1, 2), trashed('c.txt', 1, 1)];
        const container = await open();
        const rows = [...container.querySelectorAll('[role="grid"] [data-index] > *')];
        await click(rows[0]);
        await act(async () => {
            rows[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        });
        await act(async () => palette.actions?.find(({ action }) => action.id === 'delete-permanently')?.run());
        const dialog = () => document.querySelector('[role="alertdialog"], [role="dialog"]');
        const confirm = () => click(button(dialog() ?? document, 'Delete permanently'));
        await confirm();
        expect(deleted).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(dialog()?.textContent).toContain('b.txt');
        deleted.length = 0;
        await confirm();
        expect(deleted).toEqual(['b.txt']);
    } finally {
        g.fetch = realFetch;
    }
});
