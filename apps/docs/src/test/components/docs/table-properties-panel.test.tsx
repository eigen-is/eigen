// The Cells buttons mirror Format → Table: Merge and Unmerge are disabled unless the selection can run them, and follow it.
// Distribute columns gives every column one width, and the Fill row paints the selected cells.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { TablePropertiesPanel } = await import('../../../components/docs/table-properties-panel');
const { EditorTable } = await import('../../../components/docs/extensions/table');

let unmount = async () => {};
afterEach(() => unmount());

const cell = (text: string, colwidth: number[] | null = null) => ({
    type: 'tableCell',
    attrs: { colwidth },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function mount(cells = [cell('a'), cell('b')]) {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['table'] }), EditorTable],
        content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: cells }] }] },
    });
    editor.commands.setTextSelection(3);
    const rendered = await renderInDocument(createElement(TablePropertiesPanel, { editor }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
};

test('Merge and Unmerge are disabled for a caret in one cell, and Merge enables for two cells', async () => {
    const editor = await mount();
    expect(button('Merge').disabled).toBe(true);
    expect(button('Unmerge').disabled).toBe(true);

    // Cell positions: table at 0, row at 1, first cell at 2.
    const first = 2;
    const second = first + (editor.state.doc.nodeAt(first)?.nodeSize ?? 0);
    await act(async () => editor.commands.setCellSelection({ anchorCell: first, headCell: second }));
    expect(button('Merge').disabled).toBe(false);
    expect(button('Unmerge').disabled).toBe(true);
});

test('Distribute columns splits the table between its columns', async () => {
    const editor = await mount([cell('a', [100]), cell('b', [300])]);
    await act(async () => button('Distribute columns').click());
    const widths: unknown[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') widths.push(node.attrs['colwidth']);
    });
    expect(widths).toEqual([[200], [200]]);
});

// A row's control sits beside its label span.
const row = (label: string) => {
    const span = [...document.querySelectorAll('span.w-14')].find((s) => s.textContent?.trim() === label);
    const control = span?.nextElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no "${label}" row`);
    return control;
};
const click = (target: Element) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const fills = (editor: InstanceType<typeof Editor>) => {
    const found: unknown[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') found.push(node.attrs['backgroundColor']);
    });
    return found;
};

test("the Fill row paints the cells a selection holds, shows the caret cell's fill, and None takes it away", async () => {
    const editor = await mount([cell('a'), cell('b'), cell('c')]);
    expect(row('Fill').textContent).toBe('None');

    const first = 2;
    const second = first + (editor.state.doc.nodeAt(first)?.nodeSize ?? 0);
    await act(async () => editor.commands.setCellSelection({ anchorCell: first, headCell: second }));
    await click(row('Fill').querySelector('button') ?? document.body);
    const swatch = document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] button[title^="#"]');
    if (!swatch) throw new Error('the color popover has no swatch');
    await click(swatch);
    const color = swatch.title.toLowerCase();
    expect(fills(editor)).toEqual([color, color, null]);
    expect(row('Fill').textContent).toBe(color);

    await click(row('Fill').querySelector('button') ?? document.body);
    const none = [...document.querySelectorAll('[data-slot="popover-content"] button')].find(
        (b) => b.textContent?.trim() === 'None',
    );
    if (!none) throw new Error('the color popover has no None');
    await click(none);
    expect(fills(editor)).toEqual([null, null, null]);
});
