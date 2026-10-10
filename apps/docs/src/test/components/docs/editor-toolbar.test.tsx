// A writer always has the Format and Insert menus; the icon row joins them only where it fits beside them.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { createElement } = await import('react');
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
const hasIconRow = () => document.querySelector('button[aria-label^="Bold"]') !== null;

test.each([1920, 1300, 390])('a writer gets the Format and Insert menus at %ipx', async (width) => {
    await render(width, true);
    expect(menus()).toEqual(expect.arrayContaining(['File', 'Edit', 'Format', 'Insert']));
});

test('the icon row shows at 1920px and folds away at 1700px', async () => {
    await render(1920, true);
    expect(hasIconRow()).toBe(true);
    await unmount();

    await render(1700, true);
    expect(hasIconRow()).toBe(false);
});

test('a viewer gets neither the Format and Insert menus nor the icon row', async () => {
    await render(1920, false);
    expect(menus()).not.toContain('Format');
    expect(menus()).not.toContain('Insert');
    expect(hasIconRow()).toBe(false);
});
