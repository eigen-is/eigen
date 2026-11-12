// A sidebar row stays selected while the user selects an item in its list: the click adds `?pid=` (and `?uid=`,
// `?mid=`) to the URL, and the row names the page, not the selection. Only that one row looks selected. Recent files
// sits right below Drive, and outside Drive it opens Drive's page. In Drive the Trash row counts what is in the trash.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
// What the trash of the viewer's drives holds together, their own and their teams', and whose trash the sidebar asked for.
let trashedItems: { id: string }[] = [];
let trashViewer = '';
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realHome = { ...(await import('@workspace/lib/home')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => ({ data: { id: 'root-1', ownerId: 'u1', mountId: 'default' } }),
    useTrash: (viewerId: string) => {
        trashViewer = viewerId;
        return { items: trashedItems, isLoading: false, error: null };
    },
}));
mock.module('@workspace/lib/home', () => ({
    ...realHome,
    useMyTeams: () => ({
        data: [{ id: 't1', name: 'Team', mounts: [{ id: 'm1', name: 'Team drive', rootPathId: 'r1' }] }],
    }),
    useHomeSize: () => ({ data: undefined, isLoading: false }),
}));
mock.module('@workspace/lib/public', () => ({ ...realPublic, useHomeDataLabel: () => 'Contacts & Calendar' }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/home', () => realHome);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import(
    '@tanstack/react-router'
);
const { LayoutContext, useLayout } = await import('../../../../components/layout/app/layout-context');
const { AppSidebar } = await import('../../../../components/layout/sidebar/app-sidebar');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    trashedItems = [];
});

// The sidebar as an app draws it, `appName` '' being Drive, over the routes its rows link to.
async function renderSidebar(appName: string, url: string): Promise<void> {
    function Sidebar() {
        const layout = useLayout();
        return createElement(LayoutContext.Provider, { value: { ...layout, appName } }, createElement(AppSidebar));
    }
    const rootRoute = createRootRoute({ component: Sidebar });
    const paths = [
        '/',
        '/mime/$mimeType',
        '/fs/$ownerId/$mountId/$pathId',
        '/shared/$to',
        '/recent',
        '/watched',
        '/trash',
    ];
    const router = createRouter({
        routeTree: rootRoute.addChildren(paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path }))),
        history: createMemoryHistory({ initialEntries: [url] }),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
}

async function activeRows(appName: string, url: string): Promise<string[]> {
    await renderSidebar(appName, url);
    return [...document.querySelectorAll('a[data-status="active"]')].map((row) => row.textContent ?? '');
}

const SELECTED = '?pid=item-1&uid=u1&mid=default';

const CASES: ReadonlyArray<{ app: string; path: string; row: string }> = [
    { app: 'stickies', path: '/', row: 'All stickies' },
    { app: 'docs', path: '/', row: 'All docs' },
    { app: 'sheets', path: '/', row: 'All sheets' },
    { app: 'slides', path: '/', row: 'All slides' },
    { app: 'vector', path: '/', row: 'All vectors' },
    { app: 'stickies', path: '/shared/by-me', row: 'Stickies shared by me' },
    { app: '', path: '/mime/image', row: 'All images' },
    { app: '', path: '/mime/application-eigenchat', row: 'All chats' },
    { app: '', path: '/fs/u1/default/root-1', row: 'Drive' },
    { app: '', path: '/fs/team_t1/m1/r1', row: 'Team drive' },
    { app: '', path: '/shared/with-me', row: 'Shared with me' },
    { app: '', path: '/recent', row: 'Recent files' },
    { app: '', path: '/watched', row: 'Watched' },
    { app: '', path: '/trash', row: 'Trash' },
];

for (const { app, path, row } of CASES) {
    test(`${row} in ${app || 'drive'} is the one selected row, with and without an item selected`, async () => {
        expect(await activeRows(app, path)).toEqual([row]);
        await unmount();
        expect(await activeRows(app, `${path}${SELECTED}`)).toEqual([row]);
    });
}

// The router joins a link's classes without merging them, so an idle text color left on the selected row would fight
// its selected one, and the CSS order would pick the winner.
test('the selected row carries only the selected text color, and the others only the idle one', async () => {
    await renderSidebar('', '/trash');
    const selected = document.querySelector('a[data-status="active"]');
    const idle = [...document.querySelectorAll('a')].find((row) => row.textContent === 'Watched');
    if (!selected || !idle) throw new Error('the sidebar has no Trash or Watched row');
    expect([...selected.classList]).toContain('text-primary');
    expect([...selected.classList]).not.toContain('text-muted-foreground');
    expect([...idle.classList]).toContain('text-muted-foreground');
    expect([...idle.classList]).not.toContain('text-primary');
});

// The rows' labels and links in their order, up to the first filter.
async function firstRows(appName: string): Promise<[string, string | null][]> {
    await renderSidebar(appName, '/');
    return [...document.querySelectorAll('a')]
        .slice(0, 2)
        .map((row): [string, string | null] => [row.textContent ?? '', row.getAttribute('href')]);
}

test('Recent files sits right below Drive and stays inside Drive', async () => {
    expect(await firstRows('')).toEqual([
        ['Drive', '/fs/u1/default/root-1'],
        ['Recent files', '/recent'],
    ]);
});

// A link out of the app never looks selected, even on a path the app's own router knows.
test('in another app Recent files sits right below Drive and opens Drive’s page', async () => {
    const { getDriveAppUrl } = await import('@workspace/lib/api');
    expect(await firstRows('docs')).toEqual([
        ['Drive', getDriveAppUrl('fs/u1/default/root-1')],
        ['Recent files', getDriveAppUrl('recent')],
    ]);
    await unmount();
    expect(await activeRows('docs', '/recent')).toEqual([]);
});

const trashRow = () => [...document.querySelectorAll('a')].find((row) => row.textContent?.startsWith('Trash'));

test('in Drive the Trash row counts the trashed items of every drive', async () => {
    trashedItems = [{ id: 'own' }, { id: 'archived' }, { id: 'teams' }];
    await renderSidebar('', '/');
    expect(trashRow()?.textContent).toBe('Trash3');
    expect(trashViewer).toBe('u1');
});

test('in another app the Trash row shows no count and reads no trash', async () => {
    trashedItems = [{ id: 'own' }];
    await renderSidebar('docs', '/');
    expect(trashRow()?.textContent).toBe('Trash');
    expect(trashViewer).toBe('');
});
