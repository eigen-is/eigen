// The File menu takes the host's own rows above Move to trash: Slides adds Page setup, Vector adds nothing. Only the
// deck brings slides in from a file, so its File menu alone holds Import….
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DRIVE_MIME_SLIDES, DRIVE_MIME_VECTOR } = await import('@workspace/lib/types/drive');
const { PenTool, Presentation } = await import('lucide-react');
const { drivePath } = await import('../../drive-path');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { CanvasToolbar } = await import('../../../components/vector/canvas-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

async function render(props: Partial<Parameters<typeof CanvasToolbar>[0]> = {}) {
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
        ...props,
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
    await render({ fileItems: createElement(DropdownMenuItem, null, 'Page setup…') });
    await openFileMenu();
    expect(fileMenuItems().slice(-2)).toEqual(['Page setup…', 'Move to trash']);
});

test('a host with no file items, as Vector, has no Page setup', async () => {
    await render();
    await openFileMenu();
    expect(fileMenuItems()).toContain('Move to trash');
    expect(fileMenuItems()).not.toContain('Page setup…');
});

test("the deck's File menu imports, under the one label every editor's has", async () => {
    await render({ onImport: () => {} });
    await openFileMenu();
    expect(fileMenuItems()).toContain('Import…');
});

test("the drawing's File menu has no import", async () => {
    await render({
        path: drivePath({ name: 'Sketch', mimeType: DRIVE_MIME_VECTOR }),
        createLabel: 'New vector',
        createIcon: PenTool,
        createType: 'vector',
    });
    await openFileMenu();
    expect(fileMenuItems()).toContain('Move to trash');
    expect(fileMenuItems().some((item) => item?.startsWith('Import'))).toBe(false);
});

const menuItem = (label: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);

async function openDownloads(): Promise<(string | undefined)[]> {
    await openFileMenu();
    await act(async () => {
        menuItem('Download')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const submenu = [...document.querySelectorAll('[role="menu"]')].at(-1);
    return [...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent?.trim());
}

// The browser lays the drawing's text out as the canvas does, so its SVG is the canvas's own, never the server's.
test("the drawing's File › Download › SVG is the canvas's own image of the whole drawing", async () => {
    let downloads = 0;
    await render({
        path: drivePath({ name: 'Sketch.eigenvector', mimeType: DRIVE_MIME_VECTOR }),
        createLabel: 'New vector',
        createIcon: PenTool,
        createType: 'vector',
        canvasRef: {
            current: {
                insertFiles: () => {},
                insertDrivePaths: async () => {},
                insertChart: () => {},
                centerOn: () => {},
                downloadDrawing: () => {
                    downloads += 1;
                },
            },
        },
    });
    expect(await openDownloads()).toEqual(['SVG image (.svg)', 'PDF (.pdf)']);
    await act(async () => {
        menuItem('SVG image (.svg)')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(downloads).toBe(1);
});

test("a deck's File › Download is the export route's formats alone", async () => {
    await render();
    expect(await openDownloads()).toEqual(['Microsoft PowerPoint (.pptx)', 'PDF (.pdf)', 'Web page (.html)']);
});
