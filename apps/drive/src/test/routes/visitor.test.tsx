// A visitor is someone without a login who opened a public link. Drive's folder page, its shared page and its text
// editor's URL render for them over the real hooks, against a server that answers only the routes a public link opens
// and 401s the rest, as the API does. Every request the pages make is one of those routes; a signed-in user's pages,
// a guest's included, still make the rest.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();
window.happyDOM.setViewport({ width: 1440, height: 900 });
// happy-dom lays nothing out, so the list's virtualizer would see a scroller 0 px tall and draw no row.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 900 });

const OWNER = 'alice'.padEnd(32, '0');
const link = { ownerId: OWNER, visibility: 'link' as const };
// The public folder heads its own chain, cut by the server, and keeps the id of the private folder above it.
const pub = drivePath({
    ...link,
    id: 'pub',
    name: 'Holiday',
    type: 'folder',
    mimeType: DRIVE_MIME_FOLDER,
    parentId: 'alice-root',
});
const sub = drivePath({
    ...link,
    id: 'sub',
    name: 'Day one',
    type: 'folder',
    mimeType: DRIVE_MIME_FOLDER,
    parentId: 'pub',
});
const note = drivePath({ ...link, id: 'note', name: 'notes.md', mimeType: 'text/markdown', parentId: 'pub', size: 12 });
const photo = drivePath({ ...link, id: 'photo', name: 'beach.jpg', mimeType: 'image/jpeg', parentId: 'pub', size: 99 });
const report = drivePath({
    ...link,
    id: 'report',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    parentId: 'alice-root',
    size: 2048,
});
const readme = drivePath({ ...link, id: 'readme', name: 'readme.txt', mimeType: 'text/plain', parentId: 'alice-root' });
const root = drivePath({ id: 'bob-root', name: 'Drive', ownerId: 'bob', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const paths = new Map<string, DrivePath>([pub, sub, note, photo, report, readme].map((path) => [path.id, path]));
const chains = new Map<string, DrivePath[]>([
    ['pub', [pub]],
    ['sub', [pub, sub]],
    ['note', [pub, note]],
    ['photo', [pub, photo]],
    ['report', [report]],
    ['readme', [readme]],
]);

// The routes a public link opens, as the API's linkAuth lists them, and the public user and config routes.
const VISITOR_ROUTES = [
    /^\/drive\/[^/]+\/[^/]+\/path\/[^/]+(\/breadcrumb|\/permissions)?$/,
    /^\/drive\/[^/]+\/[^/]+\/folder\/[^/]+$/,
    /^\/drive\/[^/]+\/[^/]+\/file\/[^/]+\/(download|embed\/.+|preview|text-preview|vcard-preview|eml-preview|ics-preview)$/,
    /^\/drive\/[^/]+\/[^/]+\/thumb\/.+$/,
    /^\/collab\/[^/]+\/[^/]+\/[^/]+\/info$/,
    /^\/p\//,
];
const isVisitorRoute = (pathname: string) => VISITOR_ROUTES.some((route) => route.test(pathname));

// What the server answers: a signed-in user gets every route, a visitor only the routes above.
function serve(pathname: string): Response {
    const at = pathname.match(/^\/drive\/[^/]+\/[^/]+\/(path|folder)\/([^/]+)(?:\/(\w+))?$/);
    if (!session.user && !isVisitorRoute(pathname)) return Response.json({ message: 'Unauthorized' }, { status: 401 });
    if (at?.[1] === 'folder') return Response.json(at[2] === 'pub' ? [sub, note, photo] : []);
    if (at?.[3] === 'permissions') return Response.json({ canRead: paths.has(at[2]), canWrite: false });
    if (at?.[3] === 'breadcrumb') return Response.json(chains.get(at[2]) ?? []);
    if (at && !at[3]) {
        const path = paths.get(at[2]);
        return path ? Response.json(path) : Response.json({ message: 'Forbidden' }, { status: 403 });
    }
    if (pathname === '/p/users') return Response.json({ [OWNER]: { id: OWNER, name: 'Alice', email: 'alice@x.is' } });
    if (pathname.endsWith('/watch')) return Response.json({ direct: false, viaAncestor: null });
    if (pathname.endsWith('/history') || pathname.endsWith('/my-teams')) return Response.json([]);
    if (pathname.endsWith('/shared/with-me')) return Response.json([report]);
    if (pathname.endsWith('/unread-count')) return Response.json({ count: 0 });
    if (pathname.endsWith('/root')) return Response.json(root);
    return Response.json({ message: 'Not found' }, { status: 404 });
}

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const realFetch = g.fetch;
const requested: string[] = [];
beforeEach(() => {
    requested.length = 0;
    g.fetch = async (input: string | URL | Request) => {
        const pathname = new URL(typeof input === 'object' && 'url' in input ? input.url : input).pathname;
        requested.push(pathname);
        if (pathname.includes('/path/offline/')) throw new TypeError('Failed to fetch');
        return serve(pathname);
    };
});

const session: { user: { id: string; email: string; name: string; role?: string } | null } = { user: null };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => auth(),
    useIsGuest: () => session.user?.role === 'guest',
}));
afterAll(() => {
    g.fetch = realFetch;
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import('@workspace/ui/components/layout/app');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

function auth() {
    const user = session.user && { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    return {
        isAuthenticated: !!user,
        isLoading: false,
        user,
        login: async () => ({ success: true }),
        logout: async () => {},
    };
}

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    session.user = null;
});

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
    }
}

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth: auth() },
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
    await settle();
    return { container: rendered.container, router };
}

const rowNames = () => [...document.querySelectorAll('[role="row"].eigen-list-item')].map((row) => row.textContent);
const sectionLabels = () => [...document.querySelectorAll('h3')].map((label) => label.textContent);
const outsideTheLink = () => requested.filter((pathname) => !isVisitorRoute(pathname));
const permissionReads = () => requested.filter((pathname) => pathname.endsWith('/permissions'));
const locationRow = () =>
    [...document.querySelectorAll('dt')].find((label) => label.textContent === 'Location')?.nextElementSibling
        ?.textContent;
const closeButton = () => document.querySelector('[aria-label="Close"]');

test('a visitor sees a public folder with its rows, its name as the breadcrumb, and a file open beside it', async () => {
    const { container, router } = await open(`/fs/${OWNER}/default/pub?pid=photo`);
    expect(router.state.location.pathname).toBe(`/fs/${OWNER}/default/pub`);
    expect(rowNames()).toHaveLength(3);
    expect(container.querySelector('nav')?.textContent).toBe('Holiday');
    // The detail column: the item's name and details, with no section whose data needs a login.
    expect(container.querySelector('h2')?.textContent).toBe('beach.jpg');
    // The location starts at the owner, as for anyone the chain was cut for, not at a drive the visitor can't see.
    expect(locationRow()).toBe('Alice › Holiday');
    expect(sectionLabels()).toEqual(['Details']);
    const detail = container.querySelector('h2')?.parentElement;
    expect(
        detail?.querySelector('[aria-label="Watch"], [aria-label="Stop watching"], [aria-label="Share"]'),
    ).toBeNull();
    expect(outsideTheLink()).toEqual([]);
});

test('a row selection by a visitor in a public folder asks for no second permission', async () => {
    const { router } = await open(`/fs/${OWNER}/default/pub?pid=photo`);
    const before = permissionReads();
    const row = [...document.querySelectorAll<HTMLElement>('[role="row"].eigen-list-item')].find((r) =>
        r.textContent?.includes('notes.md'),
    );
    await act(async () => row?.click());
    await settle();
    expect(router.state.location.search).toEqual({ pid: 'note' });
    expect(permissionReads()).toEqual(before);
});

test('a visitor on a lone public file sees one read-only row, the file open beside it, its name and no close', async () => {
    const { container } = await open(`/shared/with-me?pid=report&uid=${OWNER}&mid=default`);
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain('report.pdf');
    expect(container.querySelector('.eigen-toolbar-title')?.textContent).toBe('report.pdf');
    expect(container.querySelector('h2')?.textContent).toBe('report.pdf');
    expect(closeButton()).toBeNull();
    expect(outsideTheLink()).toEqual([]);
});

test('a signed-in user on the same page can close the file back to the list', async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    await open(`/shared/with-me?pid=report&uid=${OWNER}&mid=default`);
    expect(closeButton()).not.toBeNull();
});

test('a visitor on the editor URL of a public text file lands on its preview page', async () => {
    const { router } = await open(`/edit/${OWNER}/default/readme`);
    expect(router.state.location.pathname).toBe('/shared/with-me');
    expect(router.state.location.search).toEqual({ pid: 'readme', uid: OWNER, mid: 'default' });
    expect(document.querySelector('h2')?.textContent).toBe('readme.txt');
});

test('a visitor on the editor URL of a private text file lands on login', async () => {
    const { router } = await open(`/edit/${OWNER}/default/secret`);
    expect(router.state.location.pathname).toBe('/login');
});

test('a signed-in user on the editor URL gets the editor', async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    const { router } = await open(`/edit/${OWNER}/default/readme`);
    expect(router.state.location.pathname).toBe(`/edit/${OWNER}/default/readme`);
    expect(router.state.matches.at(-1)?.routeId).toBe('/edit/$ownerId/$mountId/$pathId');
});

test('a visitor lands on login, with the way back, for an item the link does not open', async () => {
    const { router } = await open(`/fs/${OWNER}/default/secret`);
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: `/fs/${OWNER}/default/secret` });
});

test('a visitor lands on login when the permission read fails', async () => {
    const { router } = await open(`/fs/${OWNER}/default/offline`);
    expect(router.state.location.pathname).toBe('/login');
});

test('a visitor lands on login at once for a URL that names no item', async () => {
    for (const url of [`/fs/${OWNER}/default/root`, '/shared/by-me', '/shared/with-me', '/shared/with-me?pid=report']) {
        const { router } = await open(url);
        expect(router.state.location.pathname).toBe('/login');
        await unmount();
    }
    expect(permissionReads()).toEqual([]);
});

test('a signed-in user still reads the history and the watch state of the open item', async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is', name: 'Bob' };
    await open(`/fs/${OWNER}/default/pub?pid=photo`);
    expect(sectionLabels()).toContain('Shared with');
    expect(requested).toContain(`/drive/${OWNER}/default/path/photo/history`);
    expect(requested).toContain(`/drive/${OWNER}/default/path/photo/watch`);
});

test('a guest still reads the history and the watch state, and is offered Watch', async () => {
    session.user = { id: 'guest', email: 'guest@test.eigen.is', name: 'Guest', role: 'guest' };
    const { container } = await open(`/fs/${OWNER}/default/pub?pid=photo`);
    expect(sectionLabels()).toContain('Shared with');
    expect(container.querySelector('[aria-label="Watch"]')).not.toBeNull();
    expect(requested).toContain(`/drive/${OWNER}/default/path/photo/history`);
    expect(requested).toContain(`/drive/${OWNER}/default/path/photo/watch`);
});
