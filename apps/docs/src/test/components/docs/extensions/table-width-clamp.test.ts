// A table in the body keeps the widths it is given, each column at most the paper's width, as a page-less doc's wide
// table scrolls sideways and keeps its widths when the doc goes back to pages. A table nested in a list item or a cell,
// or in a header or a footer, is fitted to the text column after any change that takes it past.
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
const PAPER_PX = 800;

type CellAttrs = { colwidth: number[] | null };
const cell = (attrs: CellAttrs, text = 'x') => ({
    type: 'tableCell',
    attrs,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const row = (...cells: object[]) => ({ type: 'tableRow', content: cells });

// A band's editor, a header's or a footer's, is mounted with `band`.
async function mountDoc(content: object[], editable = true, band = false) {
    const editor = new Editor({
        editable,
        extensions: [
            ...getDocExtensions(),
            TableWidthClamp.configure({ textColumnWidth: () => COLUMN_PX, paperWidth: () => PAPER_PX, band }),
        ],
        content: { type: 'doc', content },
    });
    const rendered = await renderInDocument(createElement(EditorContent, { editor }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    return editor;
}

const mount = (rows: object[], editable = true) => mountDoc([{ type: 'table', content: rows }], editable);
const inListItem = (rows: object[]) => [
    {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'table', content: rows }] }],
    },
];

const widths = (editor: InstanceType<typeof Editor>) => {
    const found: (number[] | null)[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') found.push(node.attrs['colwidth']);
    });
    return found;
};

// Cell positions: table at 0, row at 1, the first cell at 2, each cell 5 long ("x" in a paragraph).
const first = 2;

test('a table in the body keeps its widths past the text column, each column at most the paper', async () => {
    const editor = await mount([row(cell({ colwidth: [200] }), cell({ colwidth: [200] }), cell({ colwidth: [200] }))]);
    const { state, view } = editor;
    view.dispatch(state.tr.setNodeMarkup(first, null, { ...state.doc.nodeAt(first)?.attrs, colwidth: [400] }));
    expect(widths(editor)).toEqual([[400], [200], [200]]);
    view.dispatch(
        view.state.tr.setNodeMarkup(first, null, { ...view.state.doc.nodeAt(first)?.attrs, colwidth: [900] }),
    );
    expect(widths(editor)).toEqual([[PAPER_PX], [200], [200]]);
});

// The list at 0, its item at 1, an empty paragraph at 2, the table at 4, its row at 5, its first cell at 6.
test('a change that takes a nested table past the text column scales every column back to it', async () => {
    const editor = await mountDoc(
        inListItem([row(cell({ colwidth: [200] }), cell({ colwidth: [200] }), cell({ colwidth: [200] }))]),
    );
    const { state, view } = editor;
    view.dispatch(state.tr.setNodeMarkup(6, null, { ...state.doc.nodeAt(6)?.attrs, colwidth: [400] }));
    expect(widths(editor)).toEqual([[300], [150], [150]]);
});

test("a band's table is fitted to the text column, as a band has no page-less strip to scroll in", async () => {
    const editor = await mountDoc(
        [
            {
                type: 'table',
                content: [row(cell({ colwidth: [200] }), cell({ colwidth: [200] }), cell({ colwidth: [200] }))],
            },
        ],
        true,
        true,
    );
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
