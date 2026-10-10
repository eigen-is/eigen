// A writer always has the Format and Insert menus; the icon row beside them folds from its right end as the window narrows.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { AuthProvider } = await import('@workspace/lib/auth');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { CommandPaletteProvider } = await import(
    '@workspace/ui/components/layout/app/command-palette/command-palette-provider'
);
const { EditorToolbar } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({ extensions: getDocExtensions() });

async function render(width: number, canWrite: boolean) {
    window.happyDOM.setViewport({ width, height: 1000 });
    const toolbar = createElement(EditorToolbar, {
        editor,
        canWrite,
        offline: false,
        storageUnavailable: false,
        canUndo: false,
        canRedo: false,
        onAccessDialogOpen: () => {},
        onImageUpload: () => {},
        path: drivePath({ name: 'Notes', mimeType: DRIVE_MIME_DOC }),
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

const menus = () => [...document.querySelectorAll('button[aria-haspopup="menu"]')].map((button) => button.textContent);

// The icon row's controls by name, the shortcut hint dropped.
const iconRow = () =>
    [...document.querySelectorAll('[role="toolbar"][aria-label="Formatting"] button')].map((button) =>
        (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/ \(.*\)$/, ''),
    );

const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());

async function openMenu(label: string) {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

async function openSubmenu(label: string) {
    const trigger = [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === label,
    );
    await act(async () => {
        // Enter opens a desktop submenu and drills into a phone's page alike.
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
}

const SHORT_ROW = ['Normal', 'Inter', 'Bold', 'Italic', 'Underline'];
const MIDDLE_ROW = [...SHORT_ROW, 'Text color', 'Highlight color', 'Add link', 'Insert image'];
const FULL_ROW = [
    ...MIDDLE_ROW,
    'Align left',
    'Align center',
    'Align right',
    'Bulleted list',
    'Numbered list',
    'Checklist',
    'Clear formatting',
];

test.each([1920, 1300, 1000, 390])('a writer gets the Format and Insert menus at %ipx', async (width) => {
    await render(width, true);
    expect(menus()).toEqual(expect.arrayContaining(['File', 'Edit', 'Format', 'Insert']));
});

test.each([
    [1920, FULL_ROW],
    [1400, FULL_ROW],
    [1399, MIDDLE_ROW],
    [1100, MIDDLE_ROW],
    [1099, SHORT_ROW],
    [900, SHORT_ROW],
    [899, []],
    [390, []],
])('at %ipx the icon row holds its first controls in priority order', async (width, row) => {
    await render(width, true);
    expect(iconRow()).toEqual(row);
});

// Text color, highlight and quote leave the row at some width too, so a menu must reach them at every width.
test.each(
    [1920, 1300, 1000, 390].flatMap((width) => [
        [width, 'Text', ['Text color', 'Highlight color']],
        [width, 'Heading', ['Quote']],
    ]),
)('at %ipx Format › %s holds %p', async (width, submenu, items) => {
    await render(width, true);
    await openMenu('Format');
    await openSubmenu(submenu);
    expect(menuItems()).toEqual(expect.arrayContaining(items));
});

test('a viewer gets neither the Format and Insert menus nor the icon row', async () => {
    await render(1920, false);
    expect(menus()).not.toContain('Format');
    expect(menus()).not.toContain('Insert');
    expect(iconRow()).toEqual([]);
});
