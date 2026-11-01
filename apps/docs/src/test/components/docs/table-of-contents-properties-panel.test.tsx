// The table of contents panel shows and sets the selected one's layout, how deep it lists and the look of its levels'
// entries, all six at once or one. Each write keeps the node selected, so the panel stays, and the editor redraws.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { NodeSelection } = await import('@tiptap/pm/state');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { TableOfContents } = await import('../../../components/docs/extensions/table-of-contents');
const { TableOfContentsPropertiesPanel } = await import('../../../components/docs/table-of-contents-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const heading = (level: number): JSONContent => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text: `Heading ${level}` }],
});

// A table of contents at 0, selected, above a heading of each of the first four levels.
async function mount(levels: number, attrs: Record<string, unknown> = {}, pageless = false) {
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...getDocExtensions({ exclude: ['tableOfContents'] }), TableOfContents],
        content: {
            type: 'doc',
            content: [
                { type: 'tableOfContents', attrs: { levels, ...attrs } },
                heading(1),
                heading(2),
                heading(3),
                heading(4),
            ],
        },
    });
    editor.commands.setNodeSelection(0);
    const rendered = await renderInDocument(createElement(TableOfContentsPropertiesPanel, { editor, pageless }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

// A row's control sits beside its label span.
const row = (label: string) => {
    const span = [...document.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === label);
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no "${label}" row`);
    return control;
};
// The options a row's select lists, open.
const open = async (label: string) => {
    const trigger = row(label).querySelector('[data-slot="select-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const list = [...document.querySelectorAll('[data-slot="select-content"]')].at(-1);
    return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
};
const choose = async (label: string, option: string) => {
    const item = (await open(label)).find((el) => el.textContent?.trim() === option);
    if (!item) throw new Error(`no "${option}" option under "${label}"`);
    await act(async () => {
        item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};

// The level of each entry the editor draws.
const button = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.getAttribute('aria-label') === label);

const entryLevels = (editor: InstanceType<typeof Editor>) =>
    [...editor.view.dom.querySelectorAll('nav[data-type="table-of-contents"] [data-level]')].map((line) =>
        line.getAttribute('data-level'),
    );

test('shows the levels of the selected table of contents', async () => {
    await mount(2);
    expect(row('Levels').textContent).toBe('2');
});

test('Levels writes the depth, keeps the node selected, and the editor lists to it', async () => {
    const editor = await mount(2);
    expect(entryLevels(editor)).toEqual(['1', '2']);

    await choose('Levels', '4');
    expect(editor.state.doc.child(0).attrs['levels']).toBe(4);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(0);
    expect(row('Levels').textContent).toBe('4');
    expect(entryLevels(editor)).toEqual(['1', '2', '3', '4']);
});

const attrs = (editor: InstanceType<typeof Editor>) => editor.state.doc.child(0).attrs;
const stillSelected = (editor: InstanceType<typeof Editor>) => {
    const { selection } = editor.state;
    return selection instanceof NodeSelection && selection.from === 0;
};

test.each([
    ['Plain text', { pageNumbers: true, leader: 'none' }],
    ['Links', { pageNumbers: false, leader: 'dot' }],
])('Format writes the facts of %s and shows it', async (label, facts) => {
    const editor = await mount(3);
    expect(row('Format').textContent).toBe('Dotted');
    await choose('Format', label);
    expect(attrs(editor)).toMatchObject(facts);
    expect(stillSelected(editor)).toBe(true);
    expect(row('Format').textContent).toBe(label);
});

test('Format offers the three layouts, and Dotted writes both facts back', async () => {
    const editor = await mount(3, { pageNumbers: false, leader: 'none' });
    expect((await open('Format')).map((option) => option.textContent?.trim())).toEqual([
        'Plain text',
        'Dotted',
        'Links',
    ]);
    await choose('Format', 'Dotted');
    expect(attrs(editor)).toMatchObject({ pageNumbers: true, leader: 'dot' });
});

// A page-less doc draws Links whatever is stored, and the stored facts come back with its pages.
test('a page-less doc offers Links only and shows it', async () => {
    await mount(3, { leader: 'none' }, true);
    expect(row('Format').textContent).toBe('Links');
    expect((await open('Format')).map((option) => option.textContent?.trim())).toEqual(['Links']);
});

// The FontPicker's trigger shows the font; its menu lists the fonts Eigen ships.
const pickFont = async (font: string) => {
    const trigger = row('Font').querySelector('button');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (el) => el.textContent?.trim() === font,
    );
    if (!item) throw new Error(`no "${font}" in the font menu`);
    await act(async () => item.click());
};
const toggle = (label: string) => document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
const press = (label: string) => act(async () => toggle(label)?.click());
const sizeBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
const typeSize = async (size: string) => {
    const box = sizeBox();
    if (!box) throw new Error('no size box');
    // React reads a typed value through the input's own setter.
    await act(async () => {
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, size);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
};
const levelLooks = (editor: InstanceType<typeof Editor>) =>
    ['level1', 'level2', 'level3', 'level4', 'level5', 'level6'].map((key) => attrs(editor)[key]);

test("All levels shows a level with no look as the body text: the doc's Normal font and size", async () => {
    await mount(3);
    expect(row('Level').textContent).toBe('All levels');
    expect(row('Font').textContent).toBe('Inter');
    expect(sizeBox()?.value).toBe('11');
    expect(toggle('Bold')?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle('Bold')?.hasAttribute('data-mixed')).toBe(false);
});

test('All levels shows a mix where the levels differ, and writes each change to all six', async () => {
    const editor = await mount(3, {
        level1: { font: 'Source Serif 4', size: 14, bold: true },
        level2: { italic: true },
    });
    expect(row('Font').textContent).toBe('—');
    expect(sizeBox()?.value).toBe('');
    expect(toggle('Bold')?.hasAttribute('data-mixed')).toBe(true);
    expect(toggle('Italic')?.hasAttribute('data-mixed')).toBe(true);

    await pickFont('JetBrains Mono');
    expect(levelLooks(editor)).toEqual([
        { font: 'JetBrains Mono', size: 14, bold: true },
        { font: 'JetBrains Mono', italic: true },
        ...Array(4).fill({ font: 'JetBrains Mono' }),
    ]);
    expect(stillSelected(editor)).toBe(true);
    expect(row('Font').textContent).toBe('JetBrains Mono');

    // A step moves each level from its own size, so the mix stays a mix.
    await act(async () => button('Increase font size')?.click());
    expect(levelLooks(editor).map((look) => look?.size)).toEqual([15, 12, 12, 12, 12, 12]);
    expect(sizeBox()?.value).toBe('');

    await typeSize('18');
    expect(levelLooks(editor).map((look) => look?.size)).toEqual(Array(6).fill(18));
    await press('Bold');
    expect(levelLooks(editor).map((look) => look?.bold)).toEqual(Array(6).fill(true));
    expect(toggle('Bold')?.hasAttribute('data-mixed')).toBe(false);
});

test('a single level shows its own look and writes it alone', async () => {
    const editor = await mount(3, { level1: { bold: true }, level2: { font: 'Source Serif 4', size: 13 } });
    await choose('Level', 'Level 2');
    expect(row('Font').textContent).toBe('Source Serif 4');
    expect(sizeBox()?.value).toBe('13');
    expect(toggle('Bold')?.getAttribute('aria-pressed')).toBe('false');

    await press('Italic');
    expect(levelLooks(editor)).toEqual([
        { bold: true },
        { font: 'Source Serif 4', size: 13, italic: true },
        null,
        null,
        null,
        null,
    ]);
    expect(stillSelected(editor)).toBe(true);
    expect(toggle('Italic')?.getAttribute('aria-pressed')).toBe('true');
});
