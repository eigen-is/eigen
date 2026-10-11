// A writer always has the Format and Insert menus; the icon row beside them folds from its right end as the window narrows.
import { afterEach, expect, mock, test } from 'bun:test';
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
const { CommandPaletteProvider } = await import('@workspace/ui');
const { EditorToolbar } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({ extensions: getDocExtensions() });

const onReplaceImage = mock(() => {});

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
        onReplaceImage,
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

// The last-opened menu's items in order, a separator as '—'.
const openMenuEntries = () =>
    [
        ...([...document.querySelectorAll('[role="menu"]')]
            .at(-1)
            ?.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"]') ?? []),
    ].map((entry) => (entry.getAttribute('role') === 'separator' ? '—' : entry.textContent?.trim()));

// A menu trigger by its text, or by its name when it is an icon.
const menuTrigger = (label: string) =>
    [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === label || button.getAttribute('aria-label') === label,
    );

async function openMenu(label: string) {
    const trigger = menuTrigger(label);
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

const SHORT_ROW = ['Normal text', 'Inter', 'Bold', 'Italic', 'Underline'];
const MIDDLE_ROW = [...SHORT_ROW, 'Text color', 'Highlight color', 'Add link', 'Insert image'];
const FULL_ROW = [...MIDDLE_ROW, 'Align', 'Bulleted list', 'Numbered list', 'Checklist', 'Clear formatting'];

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
        [width, 'Paragraph styles', ['Quote']],
    ]),
)('at %ipx Format › %s holds %p', async (width, submenu, items) => {
    await render(width, true);
    await openMenu('Format');
    await openSubmenu(submenu);
    expect(menuItems()).toEqual(expect.arrayContaining(items));
});

test("Format's submenus follow Google Docs' names and order", async () => {
    await render(1920, true);
    await openMenu('Format');
    expect(openMenuEntries()).toEqual([
        'Text',
        'Font',
        '—',
        'Paragraph styles',
        'Align and indent',
        'Bullets and numbering',
        '—',
        'Table',
        'Image',
        '—',
        'Clear formatting',
    ]);
});

test('Format › Text puts the Eigen-only marks after the scripts and capitalisation last', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Text');
    expect(openMenuEntries()).toEqual([
        'Bold',
        'Italic',
        'Underline',
        'Strikethrough',
        'Superscript',
        'Subscript',
        'Inline code',
        'Small',
        'Small caps',
        expect.stringMatching(/^All caps/),
        '—',
        'Text color',
        'Highlight color',
    ]);
});

test('Format › Paragraph styles lists Normal text, Heading 1 to 6 and then Quote', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Paragraph styles');
    expect(openMenuEntries()).toEqual([
        'Normal text',
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
        '—',
        'Quote',
    ]);
});

test('the style picker offers Heading 1 to 6 and reads Heading 5 in a Heading 5', async () => {
    editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'Fine print' }] }],
    });
    editor.commands.setTextSelection(1);
    await render(1920, true);
    expect(iconRow()[0]).toBe('Heading 5');

    await openMenu('Heading 5');
    expect(menuItems()).toEqual([
        'Normal text',
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
    ]);
});

test('Format › Align and indent lists Left, Center, Right and Justified, as Google does', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Align and indent');
    expect(openMenuEntries()).toEqual(['Left', 'Center', 'Right', 'Justified']);
});

// The trigger draws the paragraph's alignment, as Google's does, so its first icon names it.
const alignIcon = () => menuTrigger('Align')?.querySelector('svg')?.getAttribute('class');

test("the row's one Align dropdown marks the paragraph's alignment and Justified justifies it", async () => {
    editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
    });
    editor.commands.setTextSelection(1);
    await render(1920, true);
    expect(alignIcon()).toMatch(/text-align-start/);

    await openMenu('Align');
    expect(openMenuEntries()).toEqual(['Left', 'Center', 'Right', 'Justified']);
    const checked = () =>
        [...document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map((item) =>
            item.textContent?.trim(),
        );
    expect(checked()).toEqual(['Left']);

    const justified = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent?.trim() === 'Justified',
    );
    await act(async () => justified?.click());
    expect(editor.state.doc.firstChild?.attrs['textAlign']).toBe('justify');
    expect(alignIcon()).toMatch(/text-align-justify/);

    await openMenu('Align');
    expect(checked()).toEqual(['Justified']);
});

test('Format › Bullets and numbering lists numbered before bulleted, as Google does', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Bullets and numbering');
    expect(openMenuEntries()).toEqual(['Numbered list', 'Bulleted list', 'Checklist']);
});

// "a" at 1, a figure at 2, then a 2×2 table whose first cell's text sits at 7.
const TABLE_AND_FIGURE = {
    type: 'doc',
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'a' },
                { type: 'figure', attrs: { mediaName: 'chart.png' } },
            ],
        },
        {
            type: 'table',
            content: [0, 1].map(() => ({
                type: 'tableRow',
                content: [0, 1].map(() => ({ type: 'tableCell', content: [{ type: 'paragraph' }] })),
            })),
        },
    ],
};

const submenuDisabled = (label: string) =>
    [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.trim() === label)
        ?.getAttribute('aria-disabled') === 'true';

async function clickItem(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    await act(async () => item?.click());
}

test.each([
    ['in a paragraph', false, false, () => editor.commands.setTextSelection(1)],
    ['in a table', true, false, () => editor.commands.setTextSelection(7)],
    ['on a figure', false, true, () => editor.commands.setNodeSelection(2)],
])('%s, Format › Table is enabled %p and Format › Image %p', async (_, table, image, select) => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    select();
    await render(1920, true);
    await openMenu('Format');
    expect(submenuDisabled('Table')).toBe(!table);
    expect(submenuDisabled('Image')).toBe(!image);
});

test("Format › Table lists the table panel's actions in Google Docs' order and runs them", async () => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    editor.commands.setTextSelection(7);
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Table');
    expect(openMenuEntries()).toEqual([
        'Insert row above',
        'Insert row below',
        'Insert column left',
        'Insert column right',
        '—',
        'Delete row',
        'Delete column',
        'Delete table',
        '—',
        'Merge cells',
        'Unmerge cells',
        '—',
        'Toggle header row',
    ]);
    // A caret merges nothing and splits only a merged cell.
    expect(submenuDisabled('Merge cells')).toBe(true);
    expect(submenuDisabled('Unmerge cells')).toBe(true);

    await clickItem('Insert row below');
    expect(editor.state.doc.child(1).childCount).toBe(3);
});

test('Format › Image › Replace image opens the picker the image panel opens', async () => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    editor.commands.setNodeSelection(2);
    onReplaceImage.mockClear();
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Image');
    expect(openMenuEntries()).toEqual(['Replace image']);

    await clickItem('Replace image');
    expect(onReplaceImage).toHaveBeenCalledTimes(1);
});

test('a viewer gets neither the Format and Insert menus nor the icon row', async () => {
    await render(1920, false);
    expect(menus()).not.toContain('Format');
    expect(menus()).not.toContain('Insert');
    expect(iconRow()).toEqual([]);
});
