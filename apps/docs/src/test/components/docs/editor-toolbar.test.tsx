// A writer always has the Format and Insert menus; the icon row beside them folds from its right end as the window narrows.
// Tools reaches everyone, viewers included.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { formatForDisplay } = await import('@tanstack/react-hotkeys');
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

// Mounted in the document, so a test can read whether it holds focus.
const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

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

test.each([1920, 1300, 1000, 390])(
    'a writer gets the File, Edit, Format, Insert and Tools menus at %ipx',
    async (width) => {
        await render(width, true);
        expect(menus().slice(0, 5)).toEqual(['File', 'Edit', 'Format', 'Insert', 'Tools']);
    },
);

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

test('a range of mixed alignments checks no Align item and draws Left', async () => {
    editor.commands.setContent({
        type: 'doc',
        content: ['center', 'right'].map((textAlign) => ({
            type: 'paragraph',
            attrs: { textAlign },
            content: [{ type: 'text', text: 'a' }],
        })),
    });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    await render(1920, true);
    expect(alignIcon()).toMatch(/text-align-start/);

    await openMenu('Align');
    expect(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')).toHaveLength(0);
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

// Tiptap refocuses the editor a frame after a pick. A browser runs that frame once the menu has closed and before its
// exit animation unmounts it, and the unmounting menu then hands focus back to its trigger unless told not to; happy-dom
// runs it before the menu closes, under its focus trap, so a pick here defers it to a timer, as a frame would.
async function pickInBrowserFrames(pick: () => Promise<void>) {
    const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        setTimeout(() => callback(performance.now()));
        return 0;
    });
    try {
        await pick();
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    } finally {
        frame.mockRestore();
    }
}

const ONE_PARAGRAPH = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] };

test.each([
    ['the style picker', 'Normal text', 'Heading 2'],
    ['the font picker', 'Inter', 'Source Serif 4'],
])('a choice in %s gives focus back to the editor', async (_, trigger, choice) => {
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(1);
    await render(1920, true);
    await openMenu(trigger);
    await pickInBrowserFrames(() => clickItem(choice));
    expect(document.activeElement === editor.view.dom).toBe(true);
});

test('a viewer gets File, Edit and Tools, but neither the Format and Insert menus nor the icon row', async () => {
    await render(1920, false);
    expect(menus().slice(0, 3)).toEqual(['File', 'Edit', 'Tools']);
    expect(menus()).not.toContain('Format');
    expect(menus()).not.toContain('Insert');
    expect(iconRow()).toEqual([]);
});

// Each row of the word count dialog as its label and its count.
const wordCountRows = () =>
    [...document.querySelectorAll('[role="dialog"] dl > div')].map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
    ]);

async function openWordCount() {
    await openMenu('Tools');
    expect(openMenuEntries()).toEqual([`Word count${formatForDisplay('Mod+Shift+C')}`]);
    const item = document.querySelector<HTMLElement>('[role="menuitem"]');
    await act(async () => item?.click());
}

const FOUR_WORDS = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello brave new world' }] }],
};

test.each([true, false])('Tools › Word count counts the whole doc for a caret (writer %p)', async (canWrite) => {
    editor.commands.setContent(FOUR_WORDS);
    editor.commands.setTextSelection(1);
    await render(1920, canWrite);
    await openWordCount();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Word count');
    expect(wordCountRows()).toEqual([
        ['Words', '4'],
        ['Characters', '21'],
        ['Characters excluding spaces', '18'],
    ]);

    const ok = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (button) => button.textContent === 'OK',
    );
    await act(async () => ok?.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Tools › Word count counts a selection out of the whole doc, as Google does', async () => {
    editor.commands.setContent(FOUR_WORDS);
    // "brave new"
    editor.commands.setTextSelection({ from: 7, to: 16 });
    await render(1920, true);
    await openWordCount();
    expect(wordCountRows()).toEqual([
        ['Words', '2 of 4'],
        ['Characters', '9 of 21'],
        ['Characters excluding spaces', '8 of 18'],
    ]);
});

test('Mod+Shift+C opens the word count, for a viewer too', async () => {
    editor.commands.setContent(FOUR_WORDS);
    await render(1920, false);
    const isMac = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
    await act(async () => {
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', {
                bubbles: true,
                key: 'C',
                code: 'KeyC',
                shiftKey: true,
                metaKey: isMac,
                ctrlKey: !isMac,
            }),
        );
    });
    expect(wordCountRows()[0]).toEqual(['Words', '4']);
});
