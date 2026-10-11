// A change that takes a table past the text column ends with the table at the column's width. Distribute columns gives
// every column one width, the table's own or, with a column of no width, the text column's.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { TableWidthClamp } = await import('../../../../components/docs/extensions/table-width-clamp');

let unmount = async () => {};
afterEach(() => unmount());

const COLUMN_PX = 600;

type CellAttrs = { colspan?: number; colwidth: number[] | null };
const cell = (attrs: CellAttrs, text = 'x') => ({
    type: 'tableCell',
    attrs,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const row = (...cells: object[]) => ({ type: 'tableRow', content: cells });

// Mounted on a page whose text column is COLUMN_PX wide, as the editor mounts it.
async function mount(rows: object[]) {
    const editor = new Editor({
        extensions: [...getDocExtensions(), TableWidthClamp],
        content: { type: 'doc', content: [{ type: 'table', content: rows }] },
    });
    const rendered = await renderInDocument(
        createElement('div', { 'data-document': '', style: { padding: 0 } }, createElement(EditorContent, { editor })),
    );
    const page = document.querySelector('[data-document]');
    if (page) Object.defineProperty(page, 'clientWidth', { value: COLUMN_PX });
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    return editor;
}

const widths = (editor: InstanceType<typeof Editor>) => {
    const found: (number[] | null)[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') found.push(node.attrs['colwidth']);
    });
    return found;
};

// Cell positions: table at 0, row at 1, the first cell at 2, each cell 5 long ("x" in a paragraph).
const first = 2;

test('a change that takes the table past the text column scales every column back to it', async () => {
    const editor = await mount([row(cell({ colwidth: [200] }), cell({ colwidth: [200] }), cell({ colwidth: [200] }))]);
    const { state, view } = editor;
    view.dispatch(state.tr.setNodeMarkup(first, null, { ...state.doc.nodeAt(first)?.attrs, colwidth: [400] }));
    expect(widths(editor)).toEqual([[300], [150], [150]]);
});

test('Distribute columns splits the width of a table whose columns all have one', async () => {
    const editor = await mount([
        row(cell({ colwidth: [100] }), cell({ colwidth: [200] }), cell({ colwidth: [60] })),
        row(cell({ colspan: 2, colwidth: [100, 200] }), cell({ colwidth: [60] })),
    ]);
    editor.commands.setTextSelection(first + 2);
    expect(editor.commands.distributeColumns()).toBe(true);
    expect(widths(editor)).toEqual([[120], [120], [120], [120, 120], [120]]);
});

test('Distribute columns fills the text column when a column has no width', async () => {
    const editor = await mount([row(cell({ colwidth: [100] }), cell({ colwidth: null }), cell({ colwidth: [0] }))]);
    editor.commands.setTextSelection(first + 2);
    expect(editor.commands.distributeColumns()).toBe(true);
    expect(widths(editor)).toEqual([[200], [200], [200]]);
});

test('Distribute columns does nothing outside a table', async () => {
    const editor = await mount([row(cell({ colwidth: [100] }))]);
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(editor.commands.distributeColumns()).toBe(false);
});
