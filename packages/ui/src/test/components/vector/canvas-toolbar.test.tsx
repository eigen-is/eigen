// The File menu takes the host's own rows above Move to trash: Slides adds Page setup, Vector adds nothing.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DRIVE_MIME_SLIDES } = await import('@workspace/lib/types/drive');
const { Presentation } = await import('lucide-react');
const { drivePath } = await import('../../drive-path');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { CanvasToolbar } = await import('../../../components/vector/canvas-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

async function render(fileItems?: string) {
    const toolbar = createElement(CanvasToolbar, {
        path: drivePath({ name: 'Deck', mimeType: DRIVE_MIME_SLIDES }),
        canWrite: true,
        canEdit: true,
        offline: false,
        storageUnavailable: false,
        undoManager: null,
        tool: 'select',
        setTool: () => {},
        toolLocked: false,
        setToolLocked: () => {},
        canvasRef: { current: null },
        onAccessDialogOpen: () => {},
        onToggleCommentPanel: () => {},
        commentPanelOpen: false,
        assignedCommentCount: 0,
        onToggleActivityPanel: () => {},
        activityPanelOpen: false,
        createLabel: 'New slides',
        createIcon: Presentation,
        createType: 'slides',
        fileItems: fileItems && createElement(DropdownMenuItem, null, fileItems),
    });
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(AuthProvider, null, createElement(CommandPaletteProvider, null, toolbar)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
}

async function openFileMenu() {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'File',
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

const fileMenuItems = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent?.trim());

test("a host's file items sit in the File menu, above Move to trash", async () => {
    await render('Page setup…');
    await openFileMenu();
    expect(fileMenuItems().slice(-2)).toEqual(['Page setup…', 'Move to trash']);
});

test('a host with no file items, as Vector, has no Page setup', async () => {
    await render();
    await openFileMenu();
    expect(fileMenuItems()).toContain('Move to trash');
    expect(fileMenuItems()).not.toContain('Page setup…');
});
