// The right end of a document's bar offers its activity to anyone who can read the history, on a desktop and in a
// phone's kebab. A visitor without a login can't read it, so they get no Activity button or row.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const session: { user: { id: string; email: string } | null } = { user: { id: 'me', email: 'me@test.eigen.is' } };
const layout = { isMobile: false };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realMedia = { ...(await import('@workspace/lib/media')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/media', () => ({ ...realMedia, useIsMobile: () => layout.isMobile }));
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/media', () => realMedia);
    fetchSpy.mockRestore();
});

const { act, createElement } = await import('react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { DocumentShareCluster } = await import('../../../../components/layout/toolbar/document-share-cluster');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    session.user = { id: 'me', email: 'me@test.eigen.is' };
    layout.isMobile = false;
});

async function render() {
    const cluster = createElement(DocumentShareCluster, {
        canWrite: false,
        onAccessDialogOpen: () => {},
        onToggleCommentPanel: () => {},
        onToggleActivityPanel: () => {},
    });
    ({ unmount } = await renderInDocument(createElement(QueryClientProvider, { client: new QueryClient() }, cluster)));
}

const labels = () =>
    [...document.querySelectorAll('button, [role="menuitem"]')].map(
        (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
    );

async function openKebab() {
    const kebab = document.querySelector('button[aria-haspopup="menu"]');
    await act(async () => {
        kebab?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

test('a signed-in reader gets Activity beside Comments, and a visitor only Comments', async () => {
    await render();
    const reader = document.body.innerHTML;
    expect(reader).toContain('Activity');
    expect(reader).toContain('Comments');
    await unmount();

    session.user = null;
    await render();
    expect(document.body.innerHTML).not.toContain('Activity');
    expect(document.body.innerHTML).toContain('Comments');
});

test("a visitor's phone kebab has Comments and no Activity", async () => {
    layout.isMobile = true;
    session.user = null;
    await render();
    await openKebab();
    expect(labels()).toContain('Comments');
    expect(labels()).not.toContain('Activity');
});
