// The Cells buttons mirror Format → Table: Merge and Unmerge are disabled unless the selection can run them, and follow it.
// Distribute columns gives every column one width.
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
