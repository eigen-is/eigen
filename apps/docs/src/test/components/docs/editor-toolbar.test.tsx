// A writer always has the Format and Insert menus; the icon row beside them folds from its right end as the window narrows.
// Tools reaches everyone, viewers included.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { collapseSeparators } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { formatForDisplay, getHotkeyManager } = await import('@tanstack/react-hotkeys');
const { Editor } = await import('@tiptap/react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { AuthProvider } = await import('@workspace/lib/auth');
const { BAND_EXCLUDED_NODES, DEFAULT_PAGE_SETUP, getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { CommandPaletteProvider } = await import('@workspace/ui');
const { EditorToolbar } = await import('../../../components/docs/editor-toolbar');
const { PositionedFigures } = await import('../../../components/docs/extensions/positioned-figure');

let unmount = async () => {};
afterEach(() => unmount());

// Mounted in the document, so a test can read whether it holds focus.
const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: [...getDocExtensions(), PositionedFigures],
});

// A band's editor, which draws every figure in line, as a note's does.
const bandExtensions = () => [
    ...getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] }),
    PositionedFigures.configure({ blockOnly: true }),
];

const onReplaceImage = mock(() => {});
const onEnterBand = mock((_band: unknown) => {});
const onPageNumbers = mock((_preset: unknown) => {});

async function render(
    width: number,
    canWrite: boolean,
    {
        active = editor,
        onInsertEquation,
        onInsertFootnote,
        inNote = false,
        sync = { offline: false, unsyncedEdits: false },
    }: {
        active?: typeof editor;
        onInsertEquation?: () => void;
        onInsertFootnote?: () => void;
        inNote?: boolean;
        sync?: { offline: boolean; unsyncedEdits: boolean };
    } = {},
) {
    window.happyDOM.setViewport({ width, height: 1000 });
    const toolbar = createElement(EditorToolbar, {
        editor: active,
        body: editor,
        canWrite,
        onInsertEquation,
        onInsertFootnote,
        inNote,
        ...sync,
        storageUnavailable: false,
        canUndo: false,
        canRedo: false,
        pageSetup: DEFAULT_PAGE_SETUP,
        onPageSetupChange: () => {},
        onUpdateNormalStyle: () => {},
        onAccessDialogOpen: () => {},
        onImageUpload: () => {},
        onReplaceImage,
        onEnterBand,
        onPageNumbers,
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
    collapseSeparators(
        [
            ...([...document.querySelectorAll('[role="menu"]')]
                .at(-1)
                ?.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"]') ?? []),
        ].map((entry) => (entry.getAttribute('role') === 'separator' ? '—' : entry.textContent?.trim())),
    );

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

const SHORT_ROW = ['Normal text', 'Inter', 'Decrease font size', 'Increase font size', 'Bold', 'Italic', 'Underline'];
const MIDDLE_ROW = [...SHORT_ROW, 'Text color', 'Highlight color', 'Add link', 'Insert image'];
const CLEAR_FORMATTING = `Clear formatting${formatForDisplay('Mod+\\')}`;
const FULL_ROW = [...MIDDLE_ROW, 'Align', 'Bulleted list', 'Numbered list', 'Checklist', 'Clear formatting'];

test.each([1920, 1300, 1000])('a writer gets the File, Edit, Format, Insert and Tools menus at %ipx', async (width) => {
    await render(width, true);
    expect(menus().slice(0, 5)).toEqual(['File', 'Edit', 'Format', 'Insert', 'Tools']);
});

// Five menus and the offline badge overflow a 360px phone, so Tools folds into the kebab there.
test('a writer on a phone gets File, Edit, Format and Insert, and no Tools', async () => {
    await render(390, true);
    expect(menus().slice(0, 4)).toEqual(['File', 'Edit', 'Format', 'Insert']);
    expect(menus()).not.toContain('Tools');
});

test.each([
    [1920, FULL_ROW],
    [1490, FULL_ROW],
    [1489, MIDDLE_ROW],
    [1270, MIDDLE_ROW],
    [1269, SHORT_ROW],
    [1090, SHORT_ROW],
    [1089, []],
    [390, []],
])('at %ipx the icon row holds its first controls in priority order', async (width, row) => {
    await render(width, true);
    expect(iconRow()).toEqual(row);
});

// Text color, highlight and quote leave the row at some width too, so a menu must reach them at every width.
test.each(
    [1920, 1400, 1090, 390].flatMap((width) => [
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
        'Line & paragraph spacing',
        'Bullets and numbering',
        '—',
        'Headers and footers',
        'Page numbers',
        'Page orientation',
        '—',
        'Table',
        'Image',
        '—',
        CLEAR_FORMATTING,
    ]);
});

test('Format › Text puts Size after the scripts as Google does, then inline code, and capitalisation last', async () => {
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
        'Size',
        'Inline code',
        'Small caps',
        expect.stringMatching(/^All caps/),
        '—',
        'Text color',
        'Highlight color',
    ]);
});

// A step replaces Small, which the schema keeps so a doc that holds it keeps its text, and no menu offers.
test("Format › Text › Size steps the size, with Google's keys", async () => {
    editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fine', marks: [{ type: 'small' }] }] }],
    });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Text');
    await openSubmenu('Size');
    expect(openMenuEntries()).toEqual([
        `Increase font size${formatForDisplay('Mod+Shift+.')}`,
        `Decrease font size${formatForDisplay('Mod+Shift+,')}`,
    ]);
    const increase = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.trim().startsWith('Increase font size'),
    );
    await act(async () => increase?.click());
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
        { type: 'textStyle', attrs: { color: null, fontFamily: null, fontSize: 10, caps: null } },
    ]);
});

// Google's "− [11] +" sits between the font and Bold.
test("the size box shows the selection's size, and a typed size replaces Small", async () => {
    editor.commands.setContent({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'body ' },
                    { type: 'text', text: 'fine', marks: [{ type: 'small' }] },
                ],
            },
        ],
    });
    editor.commands.setTextSelection(3);
    await render(1920, true);
    const box = () => document.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
    expect(box()?.value).toBe('11');
    await act(async () => editor.commands.setTextSelection({ from: 6, to: 10 }));
    expect(box()?.value).toBe('9');
    await act(async () => editor.commands.setTextSelection({ from: 1, to: 10 }));
    expect(box()?.value).toBe('');

    await act(async () => {
        const input = box();
        if (!input) return;
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '14');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(editor.getJSON().content?.[0]?.content).toEqual([
        {
            type: 'text',
            text: 'body fine',
            marks: [{ type: 'textStyle', attrs: { color: null, fontFamily: null, fontSize: 14, caps: null } }],
        },
    ]);
    expect(box()?.value).toBe('14');
});

test('Format › Paragraph styles lists Normal text, Title, Subtitle, Heading 1 to 6 and then Quote, as Google does', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Paragraph styles');
    expect(openMenuEntries()).toEqual([
        'Normal text',
        'Title',
        'Subtitle',
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

test('the style picker offers Title, Subtitle and Heading 1 to 6 and reads Heading 5 in a Heading 5', async () => {
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
        'Title',
        'Subtitle',
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
    ]);
});

test.each([
    ['Title', 'title'],
    ['Subtitle', 'subtitle'],
])('the style picker makes a paragraph a %s, reads it there, and Normal text undoes it', async (name, type) => {
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(1);
    await render(1920, true);
    await openMenu('Normal text');
    await clickItem(name);
    expect([editor.state.doc.firstChild?.type.name, iconRow()[0]]).toEqual([type, name]);

    await openMenu(name);
    await clickItem('Normal text');
    expect([editor.state.doc.firstChild?.type.name, iconRow()[0]]).toEqual(['paragraph', 'Normal text']);
});

test('Format › Align and indent lists the alignments, then the indents, as Google does', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Align and indent');
    expect(openMenuEntries()).toEqual([
        'Left',
        'Center',
        'Right',
        'Justified',
        '—',
        `Increase indent${formatForDisplay('Mod+]')}`,
        `Decrease indent${formatForDisplay('Mod+[')}`,
        '—',
        'Indentation options…',
    ]);
});

const formatted = (...attrs: Record<string, unknown>[]) => ({
    type: 'doc',
    content: attrs.map((format) => ({ type: 'paragraph', attrs: format, content: [{ type: 'text', text: 'ab' }] })),
});

// Each paragraph's stored format, unset keys left out.
const formats = () =>
    (editor.getJSON().content ?? []).map((block) =>
        Object.fromEntries(
            ['lineSpacing', 'spaceBefore', 'spaceAfter', 'indentLeft', 'indentRight', 'indentFirstLine'].flatMap(
                (key) => (block.attrs?.[key] == null ? [] : [[key, block.attrs[key]]]),
            ),
        ),
    );

async function openSpacing(content: Parameters<typeof editor.commands.setContent>[0], from = 1, to = from) {
    editor.commands.setContent(content);
    editor.commands.setTextSelection({ from, to });
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Line & paragraph spacing');
}

// S7: an unset paragraph draws Eigen's 1.4, which no preset is.
test("Format › Line & paragraph spacing lists Google's presets and ticks none for an unset paragraph", async () => {
    await openSpacing(formatted({}));
    expect(openMenuEntries()).toEqual([
        'Single',
        '1.15',
        '1.5',
        'Double',
        '—',
        'Add space before paragraph',
        'Remove space after paragraph',
        '—',
        'Custom spacing…',
    ]);
    expect(checkedPresets()).toEqual([]);
});

test('a line spacing the selected paragraphs share is ticked, a mix none, and a preset sets every one', async () => {
    await openSpacing(formatted({ lineSpacing: 1.15 }, { lineSpacing: 1.15 }), 1, 6);
    expect(checkedPresets()).toEqual(['1.15']);
    await unmount();
    await openSpacing(formatted({ lineSpacing: 1.15 }, {}), 1, 6);
    expect(checkedPresets()).toEqual([]);
    await pickPreset('Double');
    expect(formats()).toEqual([{ lineSpacing: 2 }, { lineSpacing: 2 }]);
});

test('Add and Remove space before and after toggle as Google does, 12 pt added', async () => {
    await openSpacing(formatted({}));
    await clickItem('Add space before paragraph');
    await openMenu('Format');
    await openSubmenu('Line & paragraph spacing');
    await clickItem('Remove space after paragraph');
    expect(formats()).toEqual([{ spaceBefore: 12, spaceAfter: 0 }]);
    await openMenu('Format');
    await openSubmenu('Line & paragraph spacing');
    expect(openMenuEntries()).toContain('Remove space before paragraph');
    expect(openMenuEntries()).toContain('Add space after paragraph');
    await clickItem('Remove space before paragraph');
    expect(formats()).toEqual([{ spaceBefore: 0, spaceAfter: 0 }]);
});

// A list, a quote and a table cell own the spacing of what they hold, as the docx reader and writer take it.
test('in a list item Add space before and after are disabled, and line spacing still applies', async () => {
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'ab' }] };
    await openSpacing(
        { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }] },
        3,
    );
    const disabled = [
        ...([...document.querySelectorAll('[role="menu"]')].at(-1)?.querySelectorAll('[data-disabled]') ?? []),
    ];
    expect(disabled.map((item) => item.textContent?.trim())).toEqual([
        'Add space before paragraph',
        'Add space after paragraph',
    ]);
    await pickPreset('Double');
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs['lineSpacing']).toBe(2);
});

// As Google's does: the paragraphs go back to the doc's own alignment, spacing and indents too.
test('Clear formatting takes away every paragraph format in the selection', async () => {
    const format = {
        lineSpacing: 2,
        spaceBefore: 12,
        spaceAfter: 0,
        indentLeft: 36,
        indentRight: 18,
        indentFirstLine: -18,
    };
    const text = [{ type: 'text', text: 'ab' }];
    editor.commands.setContent({
        type: 'doc',
        content: [
            { type: 'heading', attrs: { level: 2, ...format }, content: text },
            { type: 'paragraph', attrs: { ...format, textAlign: 'center' }, content: text },
            { type: 'blockquote', content: [{ type: 'paragraph', attrs: format, content: text }] },
            { type: 'paragraph', attrs: format, content: text },
        ],
    });
    editor.commands.setTextSelection({ from: 1, to: 12 });
    await render(1920, true);
    await openMenu('Format');
    await clickItem(CLEAR_FORMATTING);
    expect(formats()).toEqual([{}, {}, {}, format]);
    expect(editor.getJSON().content?.[1]?.attrs?.['textAlign']).toBeNull();
});

// As Google's does: a comment's anchor and a link aren't formatting.
test.each([
    [
        'the toolbar button',
        async () => {
            const button = [
                ...document.querySelectorAll<HTMLElement>('[role="toolbar"][aria-label="Formatting"] button'),
            ].find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Clear formatting'));
            await act(async () => button?.click());
        },
    ],
    [
        'Format › Clear formatting',
        async () => {
            await openMenu('Format');
            await clickItem(CLEAR_FORMATTING);
        },
    ],
])('%s keeps comments and links', async (_, clear) => {
    const link = { type: 'link', attrs: { href: 'https://eigen.is' } };
    const comment = { type: 'comment', attrs: { cardId: 'card-1' } };
    editor.commands.setContent({
        type: 'doc',
        content: [
            {
                type: 'heading',
                attrs: { level: 2 },
                content: [
                    {
                        type: 'text',
                        text: 'Noted',
                        marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#ff0000' } }, comment],
                    },
                    { type: 'text', text: ' here', marks: [{ type: 'italic' }, link] },
                    { type: 'equation', attrs: { mathml: '', commentCardId: 'card-2' } },
                ],
            },
        ],
    });
    editor.commands.selectAll();
    await render(1920, true);
    await clear();
    const block = editor.state.doc.firstChild;
    expect(block?.type.name).toBe('paragraph');
    const runs: [string, unknown[]][] = [];
    block?.forEach((node) => {
        runs.push([node.text ?? node.attrs['commentCardId'], node.marks.map((mark) => mark.toJSON())]);
    });
    expect(runs).toEqual([
        ['Noted', [comment]],
        [' here', [{ ...link, attrs: expect.objectContaining(link.attrs) }]],
        ['card-2', []],
    ]);
});

test('Custom spacing… and Indentation options… open their dialogs', async () => {
    await openSpacing(formatted({}));
    await clickItem('Custom spacing…');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Custom spacing');
    await unmount();
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Align and indent');
    await clickItem('Indentation options…');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Indentation options');
});

test('Increase and Decrease indent step the paragraph by 1.27 cm', async () => {
    editor.commands.setContent(formatted({}));
    editor.commands.setTextSelection(1);
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Align and indent');
    await clickItem(`Increase indent${formatForDisplay('Mod+]')}`);
    expect(formats()).toEqual([{ indentLeft: 36 }]);
    await openMenu('Format');
    await openSubmenu('Align and indent');
    await clickItem(`Decrease indent${formatForDisplay('Mod+[')}`);
    expect(formats()).toEqual([{}]);
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
    expect(openMenuEntries()).toEqual(['List options', '—', 'Numbered list', 'Bulleted list', 'Checklist']);
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

test("Format › Table lists the table panel's actions in Google Docs' order, the deletes last, and runs them", async () => {
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
        'Distribute columns',
        '—',
        'Merge cells',
        'Unmerge cells',
        '—',
        'Toggle header row',
        'Cell background color',
        '—',
        'Delete row',
        'Delete column',
        'Delete table',
    ]);
    // A caret merges nothing and splits only a merged cell.
    expect(submenuDisabled('Merge cells')).toBe(true);
    expect(submenuDisabled('Unmerge cells')).toBe(true);

    await clickItem('Insert row below');
    expect(editor.state.doc.child(1).childCount).toBe(3);
});

test('Format › Table › Cell background color fills the cell the caret is in, and None takes it away', async () => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    editor.commands.setTextSelection(7);
    const fill = () => editor.state.doc.child(1).child(0).child(0).attrs['backgroundColor'];
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Table');
    await openSubmenu('Cell background color');
    const swatch = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][title^="#"]')].at(-1);
    if (!swatch) throw new Error('no swatch');
    await act(async () => swatch.click());
    expect(fill()).toBe(swatch.title.toLowerCase());

    await openMenu('Format');
    await openSubmenu('Table');
    await openSubmenu('Cell background color');
    await clickItem('None');
    expect(fill()).toBeNull();
});

test('Format › Image › Replace image opens the picker the image panel opens', async () => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    editor.commands.setNodeSelection(2);
    onReplaceImage.mockClear();
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Image');
    expect(openMenuEntries()).toEqual([
        'Replace image',
        '—',
        'In line',
        'Wrap left',
        'Wrap right',
        'Behind text',
        'In front of text',
    ]);

    await clickItem('Replace image');
    expect(onReplaceImage).toHaveBeenCalledTimes(1);
});

// A phone has no Image panel, so Format › Image holds its layouts, the image's own checked.
test('Format › Image › In front of text places the selected image and checks it', async () => {
    editor.commands.setContent(TABLE_AND_FIGURE);
    editor.commands.setNodeSelection(2);
    await render(390, true);
    await openMenu('Format');
    await openSubmenu('Image');
    const checked = () =>
        [...document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map((item) =>
            item.textContent?.trim(),
        );
    expect(checked()).toEqual(['In line']);

    const front = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent?.trim() === 'In front of text',
    );
    await act(async () => front?.click());
    expect(editor.state.doc.nodeAt(1)?.attrs['layout']).toBe('front');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

// The menu offers what the band's and the note's Image panels offer.
test('in a band, Format › Image offers no layout, as a band holds no float', async () => {
    const band = new Editor({ extensions: bandExtensions(), content: TABLE_AND_FIGURE });
    band.commands.setNodeSelection(2);
    await render(1920, true, { active: band });
    await openMenu('Format');
    await openSubmenu('Image');
    expect(openMenuEntries()).toEqual(['Replace image']);
    band.destroy();
});

test('in a note, Format › Image offers no place in front of or behind the text', async () => {
    const note = new Editor({ extensions: bandExtensions(), content: TABLE_AND_FIGURE });
    note.commands.setNodeSelection(2);
    await render(1920, true, { active: note, inNote: true });
    await openMenu('Format');
    await openSubmenu('Image');
    expect(openMenuEntries()).toEqual(['Replace image', '—', 'In line', 'Wrap left', 'Wrap right']);
    note.destroy();
});

test('Format › Headers and footers puts the caret in the header', async () => {
    onEnterBand.mockClear();
    await render(1920, true);
    await openMenu('Format');
    await clickItem('Headers and footers');
    expect(onEnterBand.mock.calls).toEqual([['header']]);
});

const PAGE_NUMBER_ENTRIES = [
    'In the header',
    'In the header, not on the first page',
    'In the footer',
    'In the footer, not on the first page',
    '—',
    'Page number',
    'Page count',
];

test("Insert › Page elements holds Header, Footer and Google's page number presets with Page number and Page count", async () => {
    await render(1920, true);
    await openMenu('Insert');
    await openSubmenu('Page elements');
    expect(openMenuEntries()).toEqual(['Header', 'Footer', 'Page numbers']);
    await openSubmenu('Page numbers');
    expect(openMenuEntries()).toEqual(PAGE_NUMBER_ENTRIES);
});

test('Format › Page numbers holds the same presets', async () => {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Page numbers');
    expect(openMenuEntries()).toEqual(PAGE_NUMBER_ENTRIES);
});

test.each([
    ['Header', 'header'],
    ['Footer', 'footer'],
])('Insert › Page elements › %s puts the caret in the %s', async (item, band) => {
    onEnterBand.mockClear();
    await render(1920, true);
    await openMenu('Insert');
    await openSubmenu('Page elements');
    await clickItem(item);
    expect(onEnterBand.mock.calls).toEqual([[band]]);
});

test('a page number preset goes to the editor, and Page count goes in at the caret', async () => {
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(2);
    onPageNumbers.mockClear();
    await render(1920, true);
    await openMenu('Insert');
    await openSubmenu('Page elements');
    await openSubmenu('Page numbers');
    await clickItem('In the footer, not on the first page');
    expect(onPageNumbers.mock.calls).toEqual([[expect.objectContaining({ band: 'footer', onFirstPage: false })]]);

    await openMenu('Insert');
    await openSubmenu('Page elements');
    await openSubmenu('Page numbers');
    await clickItem('Page count');
    expect(editor.getJSON().content?.[0]?.content?.at(-1)).toEqual({ type: 'pageNumber', attrs: { kind: 'pages' } });
});

// A command the schema lacks is a TypeError, so the menus ask the editor they act on what it holds.
test("in a band, Insert, Format and the style picker offer only what the band's schema holds", async () => {
    const band = new Editor({ extensions: bandExtensions() });
    await render(1920, true, { active: band });
    await openMenu('Insert');
    const disabled = [...document.querySelectorAll('[role="menuitem"][aria-disabled="true"]')].map((item) =>
        item.textContent?.trim(),
    );
    expect(disabled.filter((item) => item?.startsWith('Page break') || item === 'Code block').length).toBe(2);
    expect(disabled).not.toContain('Table');

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

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await openMenu('Normal text');
    expect(menuItems()).not.toContain('Title');
    expect(menuItems()).not.toContain('Subtitle');
    band.destroy();
});

// A band shares the schema, so its paragraphs take a format as the body's do.
test("in a band, Line & paragraph spacing and Increase indent act on the band's paragraph", async () => {
    const band = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: bandExtensions(),
        content: formatted({}),
    });
    band.commands.setTextSelection(1);
    await render(1920, true, { active: band });
    await openMenu('Format');
    await openSubmenu('Line & paragraph spacing');
    await pickPreset('Double');
    await openMenu('Format');
    await openSubmenu('Align and indent');
    await clickItem(`Increase indent${formatForDisplay('Mod+]')}`);
    expect(band.getJSON().content?.[0]?.attrs).toMatchObject({ lineSpacing: 2, indentLeft: 36 });
    band.destroy();
});

// Google has Format › Page orientation beside File › Page setup; both open the one dialog.
test('Format › Page orientation opens Page setup', async () => {
    await render(1920, true);
    await openMenu('Format');
    await clickItem('Page orientation');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Page setup');
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

// Radix would hand focus back to the trigger, where the next keystrokes and ⌘Z reach nothing.
test.each(['File', 'Edit', 'Format', 'Insert', 'Tools'])(
    '%s closed with Esc gives focus back to the editor',
    async (menu) => {
        await render(1920, true);
        await openMenu(menu);
        await pickInBrowserFrames(async () => {
            await act(async () =>
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
            );
        });
        expect(document.activeElement === editor.view.dom).toBe(true);
    },
);

test('a dialog a menu opens keeps focus', async () => {
    await render(1920, true);
    await openMenu('Format');
    await pickInBrowserFrames(() => clickItem('Page orientation'));
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
});

const NUMBERED_PRESETS = ['1. 2. 3.', 'a. b. c.', 'A. B. C.', 'i. ii. iii.', 'I. II. III.'];

const listItem = (text: string) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const listOf = (attrs: Record<string, unknown>, ...texts: string[]) => ({
    type: 'orderedList',
    attrs,
    content: texts.map(listItem),
});

// "a" at 3, "b" at 8, "c" at 13.
const orderedList = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [listOf(attrs, 'a', 'b', 'c')] });

// The doc's numbered lists, and blocks as the schema stores them: the paragraph the editor keeps after a list is no list.
const lists = () => editor.getJSON().content?.filter((block) => block.type === 'orderedList');
const stored = (...content: ReturnType<typeof listOf>[]) =>
    editor.schema.nodeFromJSON({ type: 'doc', content }).toJSON().content;

const BULLETS = { type: 'doc', content: [{ type: 'bulletList', content: [listItem('a')] }] };

async function openNumberedList() {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Bullets and numbering');
    await openSubmenu('Numbered list');
}

const checkedPresets = () =>
    [...document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map((item) =>
        item.textContent?.trim(),
    );

async function pickPreset(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    await act(async () => item?.click());
}

test("Format › Bullets and numbering › Numbered list offers Google's five numbering styles", async () => {
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(1);
    await openNumberedList();
    expect(openMenuEntries()).toEqual(NUMBERED_PRESETS);
    expect(checkedPresets()).toEqual([]);
});

test.each([
    ['1. 2. 3.', null],
    ['a. b. c.', 'a'],
    ['I. II. III.', 'I'],
])('Numbered list › marks %s in a list of type %p', async (preset, type) => {
    editor.commands.setContent(orderedList({ start: 1, type }));
    editor.commands.setTextSelection(8);
    await openNumberedList();
    expect(checkedPresets()).toEqual([preset]);
});

test('Numbered list › i. ii. iii. makes a paragraph a list numbered in small roman numerals', async () => {
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(1);
    await openNumberedList();
    await pickPreset('i. ii. iii.');
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'orderedList', attrs: { start: 1, type: 'i' } });
});

// Decimal is stored as '1', so a nested list set to it keeps it over the letters an untyped one draws by depth.
test.each([
    ['A. B. C.', 'A'],
    ['1. 2. 3.', '1'],
])("Numbered list › %s sets a list's style and keeps its items and start", async (preset, type) => {
    editor.commands.setContent(orderedList({ start: 4, type: 'a' }));
    editor.commands.setTextSelection(8);
    await openNumberedList();
    await pickPreset(preset);
    expect(lists()).toEqual(stored(listOf({ start: 4, type }, 'a', 'b', 'c')));
});

test.each([
    ['in a paragraph', ONE_PARAGRAPH, true],
    ['in a bulleted list', BULLETS, true],
    ['in a numbered list', orderedList({ start: 1, type: null }), false],
])('%s, Bullets and numbering › List options is disabled %p', async (_, content, disabled) => {
    editor.commands.setContent(content);
    editor.commands.setTextSelection(3);
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Bullets and numbering');
    expect(submenuDisabled('List options')).toBe(disabled);
});

// Opens Restart numbering at the caret, types the number and confirms.
async function restartAtCaret(startAt: string) {
    await render(1920, true);
    await openMenu('Format');
    await openSubmenu('Bullets and numbering');
    await openSubmenu('List options');
    expect(openMenuEntries()).toEqual(['Restart numbering']);
    await clickItem('Restart numbering');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Restart numbering');

    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    expect(input?.value).toBe('1');
    await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, startAt);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const ok = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (button) => button.textContent === 'OK',
    );
    await act(async () => ok?.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
}

test('List options › Restart numbering at the first item sets where the list starts', async () => {
    editor.commands.setContent(orderedList({ start: 1, type: 'a' }));
    editor.commands.setTextSelection(3);
    await restartAtCaret('5');
    expect(lists()).toEqual(stored(listOf({ start: 5, type: 'a' }, 'a', 'b', 'c')));
});

test('List options › Restart numbering in the middle splits the list there, as Google does', async () => {
    editor.commands.setContent(orderedList({ start: 3, type: 'a' }));
    editor.commands.setTextSelection(9);
    await restartAtCaret('1');
    expect(lists()).toEqual(stored(listOf({ start: 3, type: 'a' }, 'a'), listOf({ start: 1, type: 'a' }, 'b', 'c')));
    // The caret stays after the b.
    const { $from } = editor.state.selection;
    expect([$from.parent.textContent, $from.parentOffset]).toEqual(['b', 1]);
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

test.each([true, false])("on a phone the kebab's Word count opens the dialog (writer %p)", async (canWrite) => {
    editor.commands.setContent(FOUR_WORDS);
    editor.commands.setTextSelection(1);
    await render(390, canWrite);
    expect(menus()).not.toContain('Tools');
    await openMenu('More actions');

    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
        entry.textContent?.trim().startsWith('Word count'),
    );
    await act(async () => item?.click());
    expect(wordCountRows()[0]).toEqual(['Words', '4']);
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

// Google Docs' Edit menu, Paste aside: Cut and Copy, then Select all and Delete, each group set apart.
const editEntries = async () => {
    await openMenu('Edit');
    const items = [...document.querySelectorAll('[role="menu"]')]
        .at(-1)
        ?.querySelectorAll('[role="menuitem"], [role="separator"]');
    return collapseSeparators(
        [...(items ?? [])].map((item) =>
            item.getAttribute('role') === 'separator'
                ? '—'
                : `${item.textContent?.trim()}${item.hasAttribute('data-disabled') ? ' (disabled)' : ''}`,
        ),
    );
};

const TWO_WORDS = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] };

test("Edit lists Cut, Copy, Select all and Delete in Google Docs' order and groups", async () => {
    editor.commands.setContent(TWO_WORDS);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await render(1920, true);
    expect(await editEntries()).toEqual([
        `Undo${formatForDisplay('Mod+Z')} (disabled)`,
        `Redo${formatForDisplay('Mod+Shift+Z')} (disabled)`,
        '—',
        `Cut${formatForDisplay('Mod+X')}`,
        `Copy${formatForDisplay('Mod+C')}`,
        '—',
        `Select all${formatForDisplay('Mod+A')}`,
        'Delete',
    ]);
});

test('with only a caret Cut, Copy and Delete are disabled, and Select all is not', async () => {
    editor.commands.setContent(TWO_WORDS);
    editor.commands.setTextSelection(1);
    await render(1920, true);
    expect(await editEntries()).toEqual(
        expect.arrayContaining([
            `Cut${formatForDisplay('Mod+X')} (disabled)`,
            `Copy${formatForDisplay('Mod+C')} (disabled)`,
            `Select all${formatForDisplay('Mod+A')}`,
            'Delete (disabled)',
        ]),
    );
});

test('a viewer can Copy and Select all, but not Cut or Delete', async () => {
    editor.commands.setContent(TWO_WORDS);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await render(1920, false);
    expect(await editEntries()).toEqual([
        `Cut${formatForDisplay('Mod+X')} (disabled)`,
        `Copy${formatForDisplay('Mod+C')}`,
        '—',
        `Select all${formatForDisplay('Mod+A')}`,
        'Delete (disabled)',
    ]);
});

test('Edit › Select all selects the whole doc and Edit › Delete removes it, focus back in the editor', async () => {
    editor.commands.setContent(TWO_WORDS);
    editor.commands.setTextSelection(1);
    await render(1920, true);
    await openMenu('Edit');
    await pickInBrowserFrames(() => clickItem(`Select all${formatForDisplay('Mod+A')}`));
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([0, editor.state.doc.content.size]);
    expect(document.activeElement === editor.view.dom).toBe(true);

    editor.commands.setTextSelection({ from: 1, to: 7 });
    await openMenu('Edit');
    await pickInBrowserFrames(() => clickItem('Delete'));
    expect(editor.getText()).toBe('world');
    expect(document.activeElement === editor.view.dom).toBe(true);
});

// The menu fires the native copy and cut ⌘C and ⌘X fire, which the editor's handlers write; a browser pass checks the
// clipboard itself.
test.each([
    ['Cut', 'cut', 'Mod+X'],
    ['Copy', 'copy', 'Mod+C'],
])('Edit › %s runs the native %s, focus back in the editor', async (label, command, shortcut) => {
    const execCommand = mock((_command: string) => true);
    document.execCommand = execCommand;
    editor.commands.setContent(TWO_WORDS);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    await render(1920, true);
    await openMenu('Edit');
    await pickInBrowserFrames(() => clickItem(`${label}${formatForDisplay(shortcut)}`));
    expect(execCommand.mock.calls).toEqual([[command]]);
    expect(document.activeElement === editor.view.dom).toBe(true);
});

// Where Google's Insert › Symbols › Equation sits relative to the chart and the line. The equation goes in once the menu
// has closed, so Radix hands the focus to no trigger after the new equation's field has taken it.
test('Insert › Equation follows Chart and inserts once the menu has closed', async () => {
    // Whether a menu was still in the page when the equation went in: Radix calls onCloseAutoFocus in a timeout its
    // unmount sets, which may run inside the click's own act under load, so the order is read at the call.
    const menuOpenAtInsert: boolean[] = [];
    const onInsertEquation = mock(() => {
        menuOpenAtInsert.push(document.querySelector('[role="menu"]') !== null);
    });
    await render(1920, true, { onInsertEquation });
    await openMenu('Insert');
    expect(openMenuEntries().slice(0, 5)).toEqual(['Link', 'Image', 'Chart', 'Equation', 'Horizontal rule']);

    await clickItem('Equation');
    for (let tick = 0; tick < 50 && onInsertEquation.mock.calls.length === 0; tick++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(menuOpenAtInsert).toEqual([false]);
});

// A phone has no panel to edit one in, and a band being edited none that follows it.
test('Insert has no Equation without a way to edit it', async () => {
    await render(1920, true);
    await openMenu('Insert');
    expect(openMenuEntries()).not.toContain('Equation');
});

// Google greys out what a header can't hold; the open note's rule shows the same.
test('Insert greys out, rather than hides, what a note or a band can’t hold', async () => {
    await render(1920, true, { onInsertEquation: () => {}, inNote: true, active: editor });
    await openMenu('Insert');
    const greyed = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .filter((item) => item.getAttribute('aria-disabled') === 'true')
        .map((item) => item.textContent?.trim());
    expect(greyed).toEqual(expect.arrayContaining(['Chart', 'Horizontal rule', 'Table', 'Code block']));
});

// Print is the server's PDF in a tab of its own, so the headers and footers print; browser print is the fallback.
describe('Print', () => {
    const opened: string[] = [];
    const browserPrint = mock(() => {});
    const pressModP = () =>
        act(async () => {
            const isMac = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', {
                    bubbles: true,
                    key: 'p',
                    code: 'KeyP',
                    metaKey: isMac,
                    ctrlKey: !isMac,
                }),
            );
        });

    beforeEach(() => {
        opened.length = 0;
        browserPrint.mockClear();
        // A tab waiting on a PDF that never comes; the PDF's own lifecycle is usePrintPdf's test.
        window.open = ((url: string) => {
            opened.push(url);
            return { closed: false, close: () => {}, location: { href: '' } };
        }) as unknown as typeof window.open;
        globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
        Object.assign(window, { print: browserPrint });
    });

    test('File › Print opens the PDF tab', async () => {
        await render(1920, false);
        await openMenu('File');
        await clickItem('Print');
        expect(opened).toEqual(['']);
        expect(browserPrint).not.toHaveBeenCalled();
    });

    test.each([
        ['offline', { offline: true, unsyncedEdits: false }],
        ['with unsynced edits', { offline: false, unsyncedEdits: true }],
    ])('%s, File › Print is browser print', async (_, sync) => {
        await render(1920, true, { sync });
        await openMenu('File');
        await clickItem('Print');
        expect(opened).toEqual([]);
        expect(browserPrint).toHaveBeenCalledTimes(1);
    });

    // EigenApp binds ⌘P on the document for every app; this stands in for it.
    test("⌘P in Docs opens the PDF tab and never reaches EigenApp's ⌘P, which takes it again once Docs is gone", async () => {
        const globalPrint = mock(() => {});
        const global = getHotkeyManager().register('Mod+P', globalPrint);
        try {
            await render(1920, true);
            await pressModP();
            expect(opened).toEqual(['']);
            expect(globalPrint).not.toHaveBeenCalled();

            await unmount();
            await pressModP();
            expect(opened).toEqual(['']);
            expect(globalPrint).toHaveBeenCalledTimes(1);
        } finally {
            global.unregister();
        }
    });
});

const footnoteItem = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.trim().startsWith('Footnote'),
    );

// Google's Insert › Page elements › Footnote, after Page numbers. It inserts once the menu has closed, so the new note's
// editor keeps the focus Radix would hand the trigger.
test('Insert › Page elements › Footnote ends the submenu and inserts once the menu has closed', async () => {
    editor.commands.setContent(ONE_PARAGRAPH);
    const onInsertFootnote = mock(() => {});
    await render(1920, true, { onInsertFootnote });
    await openMenu('Insert');
    await openSubmenu('Page elements');
    expect(openMenuEntries().at(-1)?.startsWith('Footnote')).toBe(true);
    await act(async () => footnoteItem()?.click());
    for (let tick = 0; tick < 50 && onInsertFootnote.mock.calls.length === 0; tick++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(onInsertFootnote).toHaveBeenCalledTimes(1);
});

// A code block's is pinned with insertNote, in footnote.test.ts: this editor's schema has none.
test.each([
    ['in a band', true, false],
    ['in a note', false, true],
])('Insert › Page elements › Footnote is off %s', async (_, inBand, inNote) => {
    const band = new Editor({ extensions: bandExtensions() });
    editor.commands.setContent(ONE_PARAGRAPH);
    editor.commands.setTextSelection(2);
    await render(1920, true, { onInsertFootnote: () => {}, inNote, active: inBand ? band : editor });
    await openMenu('Insert');
    await openSubmenu('Page elements');
    expect(footnoteItem()?.getAttribute('aria-disabled')).toBe('true');
    band.destroy();
});
