// A document app's list routes, its index, a team drive and Shared by me, hand their own route to the view.
// The view lists what the route's params name, shows the selection from its URL, and a selected row or the
// way back changes only the search, on the same route with the same params.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const VIEWER = 'viewer-1';
const row = drivePath({
    id: 'row-1',
    name: 'Plan',
    mimeType: 'application/eigendoc',
    ownerId: 'owner-2',
    mountId: 'team-1',
});

// Which listing each hook was asked for, and the props the view handed the layout.
const asked: { mount: string[]; aggregate: string[]; shared: string[] } = { mount: [], aggregate: [], shared: [] };
type LayoutProps = { pid?: string; onRowSelect: (path: DrivePath) => void; onBackToList: () => void };
let layout: LayoutProps | undefined;

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realLayout = { ...(await import('../../../components/drive/drive-layout')) };
const realQuickLook = { ...(await import('../../../components/drive/use-drive-quick-look')) };
const listing = { data: [row], isLoading: false, error: null };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    usePathInfo: () => ({ data: null }),
    useAggregateMimeContent: (mimeType: string) => {
        if (mimeType) asked.aggregate.push(mimeType);
        return listing;
    },
    useMimeContent: () => listing,
    useMountMimeContent: (ownerId: string, mountId: string) => {
        if (ownerId) asked.mount.push(`${ownerId}/${mountId}`);
        return listing;
    },
    useSharedPaths: (viewerId: string, direction: string) => {
        asked.shared.push(`${viewerId}/${direction}`);
        return listing;
    },
}));
mock.module('../../../components/drive/drive-layout', () => ({
    DriveLayout: (props: LayoutProps) => {
        layout = props;
        return null;
    },
}));
mock.module('../../../components/drive/use-drive-quick-look', () => ({ useDriveQuickLook: () => () => {} }));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('../../../components/drive/drive-layout', () => realLayout);
    mock.module('../../../components/drive/use-drive-quick-look', () => realQuickLook);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import(
    '@tanstack/react-router'
);
const { validateDriveSearch } = await import('@workspace/lib/drive');
const { DOCS_CONFIG } = await import('../../../components/drive/eigendoc-config');
const { EigenDocListView } = await import('../../../components/drive/eigendoc-list-view');
const { EigenDocSharedView } = await import('../../../components/drive/eigendoc-shared-view');

// The app's tree as its route files build it: the _auth guard puts the viewer in the context.
const rootRoute = createRootRoute();
const authRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_auth',
    beforeLoad: () => ({ user: { id: VIEWER } }),
});
const indexRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/',
    validateSearch: validateDriveSearch,
    component: () => <EigenDocListView config={DOCS_CONFIG} route={indexRoute} />,
});
const teamDriveRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/drive/$ownerId/$mountId',
    validateSearch: validateDriveSearch,
    component: () => <EigenDocListView config={DOCS_CONFIG} route={teamDriveRoute} />,
});
const sharedRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/shared/$to',
    validateSearch: validateDriveSearch,
    component: () => <EigenDocSharedView config={DOCS_CONFIG} route={sharedRoute} />,
});
const routeTree = rootRoute.addChildren([authRoute.addChildren([indexRoute, teamDriveRoute, sharedRoute])]);

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    asked.mount = [];
    asked.aggregate = [];
    asked.shared = [];
    layout = undefined;
});

async function open(url: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    if (!layout) throw new Error('the view drew no layout');
    return { router, layout };
}

const where = (router: { state: { location: { pathname: string; search: object } } }) => ({
    pathname: router.state.location.pathname,
    search: router.state.location.search,
});
const SELECTED = { pid: 'row-1', uid: 'owner-2', mid: 'team-1' };

test('a team drive lists the mount its params name, and a selection stays on that drive', async () => {
    const { router, layout } = await open('/drive/owner-2/team-1?pid=old&uid=owner-2&mid=team-1');
    expect(asked.mount).toContain('owner-2/team-1');
    expect(layout.pid).toBe('old');

    await act(async () => layout.onRowSelect(row));
    expect(where(router)).toEqual({ pathname: '/drive/owner-2/team-1', search: SELECTED });

    await act(async () => layout.onBackToList());
    expect(where(router)).toEqual({ pathname: '/drive/owner-2/team-1', search: {} });
});

test('the index lists every doc of the viewer, and a selection stays on the index', async () => {
    const { router, layout } = await open('/');
    expect(asked.aggregate).toEqual([DOCS_CONFIG.mimeType]);

    await act(async () => layout.onRowSelect(row));
    expect(where(router)).toEqual({ pathname: '/', search: SELECTED });
});

test('Shared by me lists the viewer’s shared side its param names, and a selection stays on it', async () => {
    const { router, layout } = await open('/shared/by-me');
    expect(asked.shared).toContain(`${VIEWER}/by-me`);

    await act(async () => layout.onRowSelect(row));
    expect(where(router)).toEqual({ pathname: '/shared/by-me', search: SELECTED });

    await act(async () => layout.onBackToList());
    expect(where(router)).toEqual({ pathname: '/shared/by-me', search: {} });
});
