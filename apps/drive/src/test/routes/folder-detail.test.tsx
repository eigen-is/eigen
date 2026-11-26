// A folder's selected item opens in a detail column beside the list. Its share, watch and ⋮ sit in the column's bar,
// its Open in the body under the name. A row opens it on a new entry and another row or an arrow key replaces that
// entry, so X or Esc goes back to the closed list. A link straight to an item closes by replace, so back after X
// does not reopen it, and a link to the share dialog closes the same way.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });
// happy-dom lays nothing out, so the list's virtualizer would see a scroller 0 px tall and draw no row. The
// window is this file's own, so the stub goes with it.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 900 });

const OWNER = 'folder-owner';
const FOLDER = `/fs/${OWNER}/default/folder`;

const folder = drivePath({
    id: 'folder',
    name: 'Projects',
    type: 'folder',
    mimeType: DRIVE_MIME_FOLDER,
    ownerId: OWNER,
});
const files = ['alpha.txt', 'bravo.txt', 'charlie.txt'].map((name) =>
    drivePath({ id: name, name, mimeType: 'text/plain', parentId: 'folder', ownerId: OWNER }),
);
const byId = new Map<string, DrivePath>([folder, ...files].map((path) => [path.id, path]));

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: OWNER, email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: DRIVE_MIME_FOLDER }) };
const contents = { data: files, isLoading: false, error: null };
const pathInfos = new Map([...byId].map(([id, path]) => [id, { data: path, isLoading: false }] as const));
const noPath = { data: null, isLoading: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realShare = { ...(await import('@workspace/ui/components/drive/drive-access-dialog')) };
// The Share dialog as a button that closes it, as its own Close does.
mock.module('@workspace/ui/components/drive/drive-access-dialog', () => ({
    DriveAccessDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
        open ? (
            <button type="button" data-testid="share" onClick={() => onOpenChange(false)}>
                Close share
            </button>
        ) : null,
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => root,
    useTrash: () => ({ items: [], isLoading: false, error: null }),
    useFolderContent: () => contents,
    usePathInfo: (_ownerId: string, _mountId: string, pathId: string | undefined) =>
        (pathId && pathInfos.get(pathId)) || noPath,
    useCanWriteFolder: () => true,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/ui/components/drive/drive-access-dialog', () => realShare);
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

// More than one URL starts the history at the last, as a link opened after the others.
async function open(...urls: string[]) {
    const history = createMemoryHistory({ initialEntries: urls, initialIndex: urls.length - 1 });
    const router = createRouter({ routeTree, history, context: { auth } });
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
    return {
        search: () => router.state.location.search,
        index: () => history.location.state.__TSR_index,
        back: () => settle(() => history.back()),
    };
}

// A back settles on the history's next tick, then the router loads the entry it lands on.
const settle = (action: () => void) =>
    act(async () => {
        action();
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

const row = (name: string) =>
    [...document.querySelectorAll('[role="grid"] [data-index]')].find((r) => r.textContent?.includes(name));
const clickRow = (name: string) =>
    act(async () => {
        const target = row(name)?.querySelector('[role="row"]') ?? row(name);
        if (!target) throw new Error(`no row ${name}`);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const arrowDown = () =>
    act(async () => {
        const grid = document.querySelector('[role="grid"]');
        if (!grid) throw new Error('no grid');
        grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
const column = () => document.querySelector('[data-slot="detail-column"]')?.firstElementChild;
const clickClose = () =>
    settle(() => column()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());

test('a row opens its item on a new entry, arrow keys replace it, and X goes back to the closed list', async () => {
    const page = await open(FOLDER);
    await clickRow('alpha.txt');
    expect(page.search()).toEqual({ pid: 'alpha.txt' });
    expect(page.index()).toBe(1);
    await arrowDown();
    await arrowDown();
    expect(page.search()).toEqual({ pid: 'charlie.txt' });
    expect(page.index()).toBe(1);
    await clickRow('alpha.txt');
    expect(page.search()).toEqual({ pid: 'alpha.txt' });
    expect(page.index()).toBe(1);
    await clickClose();
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
    expect(column()).toBeUndefined();
});

test('Esc closes the item a row opened, back to the closed list', async () => {
    const page = await open(FOLDER);
    await clickRow('bravo.txt');
    await settle(() =>
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(0);
});

test('X on an item a link opened replaces it, so back after it does not reopen the item', async () => {
    const page = await open(FOLDER, `${FOLDER}?pid=bravo.txt`);
    expect(column()).toBeDefined();
    await clickClose();
    expect(page.search()).toEqual({});
    expect(page.index()).toBe(1);
    await page.back();
    expect(page.index()).toBe(0);
    expect(page.search()).toEqual({});
});

test('share, watch and ⋮ sit in the column’s bar, and Open in the body under the name', async () => {
    await open(`${FOLDER}?pid=alpha.txt`);
    const bar = column()?.firstElementChild;
    const body = column()?.lastElementChild;
    const labels = [...(bar?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Share', 'Watch', 'More actions', 'Close']);
    expect(body?.querySelector('h2')?.textContent).toBe('alpha.txt');
    // The row under the name holds Open and Download; the sharing section further down keeps its own Share.
    const buttonsUnderName = body?.querySelector('h2')?.nextElementSibling?.querySelectorAll('button') ?? [];
    expect([...buttonsUnderName].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
        'Open',
        'Download',
    ]);
});

test('closing the share dialog a link opened replaces it, so back does not reopen the dialog', async () => {
    const page = await open(FOLDER, `${FOLDER}?pid=alpha.txt&sharePathId=bravo.txt`);
    const share = () => document.querySelector<HTMLButtonElement>('[data-testid="share"]');
    expect(share()).not.toBeNull();
    await settle(() => share()?.click());
    expect(page.search()).toEqual({ pid: 'alpha.txt' });
    expect(page.index()).toBe(1);
    await page.back();
    expect(page.index()).toBe(0);
    expect(share()).toBeNull();
});
