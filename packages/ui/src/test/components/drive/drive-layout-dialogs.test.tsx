// A guest may not mail people through the server, so Drive offers Email collaborators on a shared item
// to an editor and hides it from a guest editor.
import { afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

let isGuest = false;
const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => isGuest }));

const { createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { useDriveLayoutDialogs } = await import('../../../components/drive/drive-layout-dialogs');

let unmount = async () => {};
afterEach(() => unmount());

async function emailCollaboratorsHandler() {
    let handler: ((item: DrivePath) => void) | undefined;
    function Probe() {
        handler = useDriveLayoutDialogs({
            ownerId: 'user-1',
            mountId: 'default',
            currentPath: null,
            capabilities: DRIVE_CAPABILITIES.browse,
        }).onEmailCollaborators;
        return null;
    }
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(CommandPaletteProvider, null, createElement(Probe)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    return handler;
}

test('an editor can email the collaborators', async () => {
    isGuest = false;
    expect(await emailCollaboratorsHandler()).toBeFunction();
});

test('a guest editor can not', async () => {
    isGuest = true;
    expect(await emailCollaboratorsHandler()).toBeUndefined();
});
