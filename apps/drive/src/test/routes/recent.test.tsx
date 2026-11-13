// Recent opens newest activity first, whatever the user's view preference says, and shows each row's last
// activity. A sort picked here, from a column header, the grid's sort menu or the phone's View options, sorts
// this page only and leaves the preference every other listing follows as it was.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { RecentPath } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow, menuRows } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
// happy-dom lays nothing out, so the list's virtualizer would see a scroller 0 px tall and draw no row. The
// window is this file's own, so the stub goes with it.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 900 });

const OWNER = 'recent-owner';
const PREFERENCE_KEY = `eigen-drive-view:${OWNER}`;

const recentPath = (name: string, editedDay: number, activityDay: number): RecentPath => ({
    ...drivePath({
        id: name,
        name,
        ownerId: OWNER,
        mimeType: 'text/plain',
        updatedAt: new Date(Date.UTC(2026, 9, editedDay)),
    }),
    lastActivityAt: new Date(Date.UTC(2026, 9, activityDay)),
});

// The page's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: OWNER, email: 'me@test.eigen.is', name: 'Me' } };
const root = { data: drivePath({ id: 'root', name: 'My Drive', type: 'folder', mimeType: 'inode/directory' }) };
const recent: { data: RecentPath[]; isLoading: boolean; error: Error | null } = {
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
    useRecentPaths: () => recent,
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
    window.happyDOM.setViewport({ width: 1440, height: 900 });
    recent.data = [recentPath('alpha.txt', 10, 10), recentPath('bravo.txt', 1, 20), recentPath('charlie.txt', 25, 1)];
    preferNameInMode('list');
});

// The user keeps an alphabetical view, which Recent must not open with.
function preferNameInMode(mode: 'list' | 'grid') {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ mode, sortKey: 'name', sortDir: 'asc' }));
}
const preference = () => JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? 'null');

async function open() {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ['/recent'] }),
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

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
// The names the listing's rows or tiles show, in their order.
const names = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="grid"] [data-index]')].map((row) =>
        recent.data.map((path) => path.name).find((name) => row.textContent?.includes(name)),
    );

// Newest activity first is neither the order of the last edits nor the alphabet.
const NEWEST_FIRST = ['bravo.txt', 'alpha.txt', 'charlie.txt'];
const BY_NAME = ['alpha.txt', 'bravo.txt', 'charlie.txt'];

test('Recent opens newest activity first under Last activity, whatever the preference or the last edit says', async () => {
    const container = await open();
    expect(names(container)).toEqual(NEWEST_FIRST);
    expect(button(container, 'Last activity')).toBeDefined();
});

test('a column header sorts the page and leaves the preference alone', async () => {
    const container = await open();
    await click(button(container, 'Last activity'));
    expect(names(container)).toEqual([...NEWEST_FIRST].reverse());
    expect(preference()).toEqual({ mode: 'list', sortKey: 'name', sortDir: 'asc' });
});

test('the grid’s sort menu sorts the page and leaves the preference alone', async () => {
    preferNameInMode('grid');
    const container = await open();
    await click(button(container, 'Last activity'));
    expect(menuRows()).toEqual(['Name', 'Last activity', 'Size']);
    await clickRow('Name');
    expect(button(container, 'Name')).toBeDefined();
    expect(preference()).toEqual({ mode: 'grid', sortKey: 'name', sortDir: 'asc' });
});

test('the phone’s View options sort the page and leave the preference alone', async () => {
    window.happyDOM.setViewport({ width: 390, height: 844 });
    const container = await open();
    await click(container.querySelector('button[aria-label="View options"]'));
    expect(menuRows()).toContain('Last activity');
    await clickRow('Name');
    expect(names(container)).toEqual(BY_NAME);
    expect(preference()).toEqual({ mode: 'list', sortKey: 'name', sortDir: 'asc' });
});

test('an empty Recent shows the standard empty text in place of the table, with no hint', async () => {
    recent.data = [];
    const container = await open();
    expect(container.textContent).toContain('Within this void, all possibilities are yet unobserved.');
    expect(container.querySelector('[role="grid"]')).toBeNull();
    expect(container.textContent).not.toContain('Drop files');
});
