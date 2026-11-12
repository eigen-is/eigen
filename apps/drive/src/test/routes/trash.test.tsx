// The trash lists what was deleted, and "Modified" sorts it by when each item was trashed, not by its last
// edit. An empty or failed trash shows the standard text, and a line names each drive that failed while
// others loaded. Empty trash shows only when there is something to empty, and asks before it deletes
// everything.
// A trashed row's menu and the command palette offer the same two rows: Restore and Delete permanently.
// When Delete permanently gets only part of a selection through, the dialog stays open on the items that
// failed, and confirming again sends only those. A canceled dialog keeps its count while it fades out.
// The list spans every drive the viewer can restore from, so a team drive's item shows its team under Owner,
// and Restore and Delete permanently reach that team's drive. Empty trash empties the viewer's own mounts
// only, and says so when team items are listed.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { closingDialog, holdClosingDialogs } from '@workspace/ui/test/closing-dialog';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, menuRows } from '@workspace/ui/test/menu-rows';
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

const OWN = { ownerId: 'trash-owner', mountId: 'default' };
const TEAM = { ownerId: 'team_design', mountId: 'shared' };

const trashed = (name: string, editedDay: number, trashedDay: number, drive = OWN): DrivePath =>
    drivePath({
        id: name,
        name,
        ...drive,
        mimeType: 'text/plain',
        updatedAt: new Date(Date.UTC(2026, 9, editedDay)),
        trashedAt: new Date(Date.UTC(2026, 9, trashedDay)),
    });

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: 'trash-owner', email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }) };
const trash: { items: DrivePath[]; failedDrives: readonly string[]; isLoading: boolean; error: Error | null } = {
    items: [],
    failedDrives: [],
    isLoading: false,
    error: null,
};
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    useTrash: () => trash,
}));
// An owner's avatar reads its name from the server: the team is Design, the viewer Me.
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ userId }: { userId?: string }) => ({
        displayName: userId === TEAM.ownerId ? 'Design' : 'Me',
        resolvedEmail: '',
        avatarSrc: undefined,
        isLoading: false,
    }),
}));

// The server behind the page's writes: the viewer has two mounts, every write to a trash route is recorded
// as its method and path, and `b.txt` is refused.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const realFetch = g.fetch;
const writes: string[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const route = decodeURIComponent(new URL(input instanceof Request ? input.url : String(input)).pathname);
    if (route === `/drive/${OWN.ownerId}/mounts`) return Response.json([{ id: 'default' }, { id: 'archive' }]);
    if (!route.includes('/trash') || !init?.method || init.method === 'GET') return realFetch(input, init);
    writes.push(`${init.method} ${route}`);
    if (route.endsWith('/b.txt')) return new Response('No access', { status: 403 });
    return Response.json({ success: true });
};
const EMPTIED = ['DELETE /drive/trash-owner/archive/trash', 'DELETE /drive/trash-owner/default/trash'];

afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/public', () => realPublic);
    g.fetch = realFetch;
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
    trash.items = [];
    trash.failedDrives = [];
    trash.isLoading = false;
    trash.error = null;
    writes.length = 0;
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
const dialog = () => document.querySelector('[role="alertdialog"], [role="dialog"]');
// The names the list's rows show, in their order.
const names = (container: HTMLElement, all: string[]) =>
    [...container.querySelectorAll('[role="grid"] [data-index]')].map((row) =>
        all.find((name) => row.textContent?.includes(name)),
    );
// The row that shows `name`, and its menu.
const row = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll('[role="grid"] [role="row"]')].find((entry) => entry.textContent?.includes(name));
const openRowMenu = (container: HTMLElement, name: string) =>
    act(async () => {
        row(container, name)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });

test('the trash sorts newest trashed first, whatever was edited last', async () => {
    trash.items = [trashed('old-edit.txt', 1, 20), trashed('new-edit.txt', 25, 10), trashed('middle.txt', 5, 15)];
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
    trash.error = new Error('The server is unreachable');
    const container = await open();
    expect(container.textContent).toContain('Encountering the null vector: a rendezvous with nothing at all.');
    expect(container.textContent).not.toContain('The server is unreachable');
    expect(container.textContent).not.toContain('Within this void, all possibilities are yet unobserved.');
});

test('a drive whose trash failed to load is named above the list of the others', async () => {
    trash.items = [trashed('a.txt', 1, 2)];
    trash.failedDrives = ['Design files', 'Archive'];
    const container = await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not load the trash of Design files, Archive',
    );
    expect(names(container, ['a.txt'])).toEqual(['a.txt']);
});

test('a trash where every drive failed shows only the null vector, with no line naming them', async () => {
    trash.error = new Error('The server is unreachable');
    trash.failedDrives = ['My Drive'];
    const container = await open();
    expect(container.textContent).toContain('Encountering the null vector: a rendezvous with nothing at all.');
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('Empty trash asks first, then empties every mount of the viewer', async () => {
    trash.items = [trashed('a.txt', 1, 2)];
    const container = await open();
    await click(button(container, 'Empty trash'));
    expect(writes).toEqual([]);
    expect(dialog()?.textContent).toContain('permanently delete all items in trash');
    expect(dialog()?.textContent).not.toContain('team drives');
    await click(button(dialog() ?? document, 'Empty trash'));
    expect([...writes].sort()).toEqual(EMPTIED);
});

test('with team items listed, Empty trash says they stay and empties no team drive', async () => {
    trash.items = [trashed('a.txt', 1, 2), trashed('team.txt', 1, 3, TEAM)];
    const container = await open();
    await click(button(container, 'Empty trash'));
    expect(dialog()?.querySelector('p')?.textContent).toBe(
        'Are you sure you want to permanently delete all items from your own drive? Items from team drives stay in the trash. This action cannot be undone.',
    );
    await click(button(dialog() ?? document, 'Empty trash'));
    expect([...writes].sort()).toEqual(EMPTIED);
});

test('a trash that holds only team items offers nothing to empty', async () => {
    trash.items = [trashed('team.txt', 1, 3, TEAM)];
    const container = await open();
    expect(names(container, ['team.txt'])).toEqual(['team.txt']);
    expect(buttonLabels(container)).not.toContain('Empty trash');
});

test('while the trash loads it claims nothing', async () => {
    trash.isLoading = true;
    const container = await open();
    expect(container.textContent).not.toContain('Within this void, all possibilities are yet unobserved.');
    expect(buttonLabels(container)).not.toContain('Empty trash');
});

test('an item trashed in a team drive shows its team under Owner', async () => {
    trash.items = [trashed('a.txt', 1, 2), trashed('team.txt', 1, 3, TEAM)];
    const container = await open();
    expect(container.querySelector('[role="grid"]')?.textContent).toContain('Owner');
    await act(async () => {
        row(container, 'team.txt')
            ?.querySelector('[data-slot="tooltip-trigger"]')
            ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Design');
});

test('Restore on a team drive’s item restores it in that team’s drive', async () => {
    trash.items = [trashed('a.txt', 1, 2), trashed('team.txt', 1, 3, TEAM)];
    const container = await open();
    await openRowMenu(container, 'team.txt');
    await clickRow('Restore');
    expect(writes).toEqual(['POST /drive/team_design/shared/trash/team.txt/restore']);
});

test('Delete permanently on a team drive’s item deletes it from that team’s drive', async () => {
    trash.items = [trashed('a.txt', 1, 2), trashed('team.txt', 1, 3, TEAM)];
    const container = await open();
    await openRowMenu(container, 'team.txt');
    await clickRow('Delete permanently');
    await click(button(dialog() ?? document, 'Delete permanently'));
    expect(writes).toEqual(['DELETE /drive/team_design/shared/trash/team.txt']);
});

test('the palette offers a trashed item only Restore and Delete permanently', async () => {
    trash.items = [trashed('a.txt', 1, 2)];
    const container = await open();
    await click(container.querySelector('[role="grid"] [data-index] > *'));
    expect(palette.actions?.map(({ action }) => action.label)).toEqual(['Restore', 'Delete permanently']);
});

test('a trashed row’s menu draws the same rows, Delete permanently last and red', async () => {
    trash.items = [trashed('a.txt', 1, 2)];
    const container = await open();
    await openRowMenu(container, 'a.txt');
    expect(menuRows()).toEqual(['Restore', '—', 'Delete permanently']);
    const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(rows.map((entry) => entry.getAttribute('data-variant'))).toEqual(['default', 'destructive']);
});

test('the Delete permanently dialog keeps its count while it closes', async () => {
    const release = holdClosingDialogs();
    try {
        trash.items = [trashed('a.txt', 1, 3), trashed('b.txt', 1, 2), trashed('c.txt', 1, 1)];
        const container = await open();
        const rows = [...container.querySelectorAll('[role="grid"] [data-index] > *')];
        await click(rows[0]);
        await act(async () => {
            rows[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        });
        await act(async () => palette.actions?.find(({ action }) => action.id === 'delete-permanently')?.run());
        await click(button(document.querySelector('[role="dialog"]') ?? document, 'Cancel'));
        expect(closingDialog()?.querySelector('p')?.textContent).toBe(
            'Are you sure you want to permanently delete 3 items? This action cannot be undone.',
        );
    } finally {
        release();
    }
});

test('confirming Delete permanently again after a partial failure sends only the refused item', async () => {
    trash.items = [trashed('a.txt', 1, 3), trashed('b.txt', 1, 2), trashed('c.txt', 1, 1)];
    const container = await open();
    const rows = [...container.querySelectorAll('[role="grid"] [data-index] > *')];
    await click(rows[0]);
    await act(async () => {
        rows[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    await act(async () => palette.actions?.find(({ action }) => action.id === 'delete-permanently')?.run());
    const confirm = () => click(button(dialog() ?? document, 'Delete permanently'));
    await confirm();
    expect(writes).toEqual(['a.txt', 'b.txt', 'c.txt'].map((id) => `DELETE /drive/trash-owner/default/trash/${id}`));
    expect(dialog()?.textContent).toContain('b.txt');
    writes.length = 0;
    await confirm();
    expect(writes).toEqual(['DELETE /drive/trash-owner/default/trash/b.txt']);
});
