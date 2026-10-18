// The Headers and footers panel is a writer's, on a desktop: a click on a band opens it in the slot the comments and
// activity panels take back, and losing write access closes it. A viewer and a phone get no panel and no Page elements.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useState } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const realAuth = await import('@workspace/lib/auth');
const realCollab = await import('@workspace/lib/collab');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { CommandPaletteProvider } = await import('@workspace/ui');
const { LayoutContext } = await import('@workspace/ui/components/layout/app/layout-context');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { drivePath } = await import('@workspace/ui/test/drive-path');

const doc = new Y.Doc();
const provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// A synced doc, with no server behind it.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: () => ({
        doc,
        provider,
        offline: false,
        loaded: true,
        storageUnavailable: false,
        storageGone: false,
        unsyncedEdits: false,
    }),
}));
// A writer signed in, without the session check.
const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
        createdAt: new Date('2026-09-20T09:00:00Z'),
        updatedAt: new Date('2026-09-20T09:00:00Z'),
    },
    login: async () => ({ success: true }),
    logout: async () => {},
};
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => auth }));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
    provider.destroy();
});

const { CollaborativeEditor } = await import('../../../components/docs/editor');

// Every request answers empty.
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);

let unmount = async () => {};
afterEach(() => unmount());

let setCanWrite = (_canWrite: boolean) => {};

async function render({ canWrite, isMobile }: { canWrite: boolean; isMobile: boolean }) {
    function Editor() {
        const [writer, setWriter] = useState(canWrite);
        setCanWrite = setWriter;
        return createElement(CollaborativeEditor, {
            path: drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC }),
            canWrite: writer,
            mediaFolderId: null,
            chatFolderId: null,
            onAccessDialogOpen: () => {},
        });
    }
    const router = createRouter({
        routeTree: createRootRoute({
            component: () =>
                createElement(
                    LayoutContext,
                    { value: { ...LAYOUT, isMobile } },
                    createElement(
                        PreviewProvider,
                        null,
                        createElement(CommandPaletteProvider, null, createElement(Editor)),
                    ),
                ),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

const LAYOUT = {
    appName: 'Docs',
    setAppName: () => {},
    documentTitle: '',
    setDocumentTitle: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarColumnShown: false,
    sidebarMode: 'none' as const,
    sidebarHidden: true,
    setSidebarHidden: () => {},
    isMobile: false,
    isTablet: false,
};

const panelOpen = () => document.querySelector('[data-band]') !== null;

async function clickBand() {
    await act(async () => document.querySelector<HTMLElement>('[data-page-band="footer"]')?.click());
}

async function clickButton(label: string) {
    await act(async () => document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.click());
}

async function insertMenuItems() {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'Insert',
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
}

test('a click on a band opens the panel, and opening the comments or the activity closes it', async () => {
    await render({ canWrite: true, isMobile: false });
    expect(await insertMenuItems()).toContain('Page elements');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    for (const panel of ['Comments', 'Activity']) {
        await clickBand();
        expect(panelOpen()).toBe(true);
        await clickButton(panel);
        expect(panelOpen()).toBe(false);
        await clickButton(panel);
    }
});

test('losing write access closes the panel', async () => {
    await render({ canWrite: true, isMobile: false });
    await clickBand();
    expect(panelOpen()).toBe(true);
    await act(async () => setCanWrite(false));
    expect(panelOpen()).toBe(false);
    await act(async () => setCanWrite(true));
    expect(panelOpen()).toBe(false);
});

test.each([
    ['a viewer', { canWrite: false, isMobile: false }],
    ['a phone', { canWrite: true, isMobile: true }],
])('%s gets no panel and no Page elements', async (_, who) => {
    await render(who);
    await clickBand();
    expect(panelOpen()).toBe(false);
    expect(await insertMenuItems()).not.toContain('Page elements');
});
