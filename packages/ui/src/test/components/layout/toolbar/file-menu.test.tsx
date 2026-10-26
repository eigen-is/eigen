// A guest may not mail people through the server, so the File menu offers Email collaborators to an
// editor and hides it from a guest editor.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

let isGuest = false;
const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => isGuest }));

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('../../../drive-path');
const { CommandPaletteProvider } = await import(
    '../../../../components/layout/app/command-palette/command-palette-provider'
);
const { FileMenu } = await import('../../../../components/layout/toolbar/file-menu');

let unmount = async () => {};
afterEach(() => unmount());

async function fileMenuItems(): Promise<(string | undefined)[]> {
    const menu = createElement(FileMenu, {
        path: drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC }),
        canWrite: true,
        onAccessDialogOpen: () => {},
        createLabel: 'New doc',
        createType: 'doc',
    });
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(CommandPaletteProvider, null, menu),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));

    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'File',
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent?.trim());
}

test('an editor can email the collaborators', async () => {
    isGuest = false;
    expect(await fileMenuItems()).toContain('Email collaborators');
});

test('a guest editor can not', async () => {
    isGuest = true;
    const items = await fileMenuItems();
    expect(items).toContain('Rename');
    expect(items).not.toContain('Email collaborators');
});
