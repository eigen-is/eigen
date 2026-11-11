// The File menu takes the host's own rows above Move to trash: Slides adds Page setup, Vector adds nothing. Only the
// deck brings slides in from a file, so its File menu alone holds Import…. The Edit menu acts on the canvas's selection
// as Google Slides' does, and keeps the tools, which below the compact breakpoint no button reaches.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { collapseSeparators } from '../../menu-rows';
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
const { DocSearchProvider } = await import('../../../components/search/doc-search-provider');
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
        selectionEmpty: true,
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
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {} };
    const router = createRouter({
        routeTree: createRootRoute({
            component: () =>
                createElement(
                    AuthProvider,
                    null,
                    createElement(
                        CommandPaletteProvider,
                        null,
                        createElement(DocSearchProvider, { controller, children: toolbar }),
                    ),
                ),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
}

async function openMenu(label: string) {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

const openFileMenu = () => openMenu('File');

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

// A canvas handle that does nothing but log the clipboard rows it is asked for.
function handle(log: string[] = []) {
    return {
        insertFiles: () => {},
        insertDrivePaths: async () => {},
        insertChart: () => {},
        centerOn: () => {},
        downloadDrawing: () => {},
        cut: () => log.push('cut'),
        copy: () => log.push('copy'),
        paste: () => log.push('paste'),
        duplicate: () => log.push('duplicate'),
        delete: () => log.push('delete'),
    };
}

// A row's label without its trailing shortcut, which reads per platform and can repeat a letter of the label (Eraser, E).
function rowLabel(item: Element) {
    const text = item.textContent?.trim() ?? '';
    const shortcut = item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '';
    return text.slice(0, text.length - shortcut.length).trim();
}
// The open menu's rows, a separator as '—'.
const menuRows = () =>
    collapseSeparators(
        [...(document.querySelector('[role="menu"]')?.children ?? [])].map((row) =>
            row.getAttribute('role') === 'separator' ? '—' : rowLabel(row),
        ),
    );
const menuItem = (label: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => rowLabel(item) === label);
const disabledRows = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"][data-disabled]')].map(rowLabel);

test("an editor's Edit menu puts the clipboard rows above the tools", async () => {
    await render({ selectionEmpty: false });
    await openMenu('Edit');
    expect(menuRows()).toEqual([
        'Undo',
        'Redo',
        '—',
        'Cut',
        'Copy',
        'Paste',
        '—',
        'Duplicate',
        'Delete',
        '—',
        'Select',
        'Eraser',
        'Keep selected tool',
        '—',
        'Find',
    ]);
    expect(disabledRows()).toEqual(['Undo', 'Redo']);
});

test('with nothing selected only Paste of the clipboard rows stays enabled', async () => {
    await render();
    await openMenu('Edit');
    expect(disabledRows()).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Duplicate', 'Delete']);
});

test('a viewer keeps Copy and Find, and no row that writes', async () => {
    await render({ canEdit: false });
    await openMenu('Edit');
    expect(menuRows()).toEqual(['Copy', '—', 'Find']);
});

test("an Edit row runs the canvas's own action", async () => {
    const log: string[] = [];
    await render({ selectionEmpty: false, canvasRef: { current: handle(log) } });
    for (const label of ['Cut', 'Copy', 'Paste', 'Duplicate', 'Delete']) {
        await openMenu('Edit');
        await act(async () => {
            menuItem(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }
    expect(log).toEqual(['cut', 'copy', 'paste', 'duplicate', 'delete']);
});

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
                ...handle(),
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
