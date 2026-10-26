// A change that takes a table past the text column ends with the table at the column's width.
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

type CellAttrs = { colwidth: number[] | null };
const cell = (attrs: CellAttrs, text = 'x') => ({
    type: 'tableCell',
    attrs,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const row = (...cells: object[]) => ({ type: 'tableRow', content: cells });

async function mount(rows: object[], editable = true) {
    const editor = new Editor({
        editable,
        extensions: [...getDocExtensions(), TableWidthClamp.configure({ textColumnWidth: () => COLUMN_PX })],
        content: { type: 'doc', content: [{ type: 'table', content: rows }] },
    });
    const rendered = await renderInDocument(createElement(EditorContent, { editor }));
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

test("a viewer's tab leaves a table past the column as it is", async () => {
    const editor = await mount(
        [row(cell({ colwidth: [200] }), cell({ colwidth: [200] }), cell({ colwidth: [200] }))],
        false,
    );
    const { state, view } = editor;
    view.dispatch(state.tr.setNodeMarkup(first, null, { ...state.doc.nodeAt(first)?.attrs, colwidth: [400] }));
    expect(widths(editor)).toEqual([[400], [200], [200]]);
});
