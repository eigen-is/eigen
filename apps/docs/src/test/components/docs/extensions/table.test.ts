// Google Docs' column drag: the border between two columns moves width from one to the other and the table keeps its
// width, each column stopping at the floor; the table's right edge sets the table's width, up to the text column. The
// first drag on a table stores every column's drawn width, and undoing it draws the columns as before.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { history, undo } = await import('@tiptap/pm/history');
const { columnResizingPluginKey } = await import('@tiptap/pm/tables');
const { getDocExtensions, MIN_TABLE_COLUMN_PX } = await import('@workspace/lib/docs/eigendoc');
const { EditorTable } = await import('../../../../components/docs/extensions/table');
const { TableWidthClamp } = await import('../../../../components/docs/extensions/table-width-clamp');

let unmount = async () => {};
afterEach(() => unmount());

const COLUMN_PX = 600;

type CellAttrs = { colspan?: number; colwidth: number[] | null };
const cell = (attrs: CellAttrs) => ({
    type: 'tableCell',
    attrs,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
});
const row = (...cells: object[]) => ({ type: 'tableRow', content: cells });
const widthRow = (...widths: (number | null)[]) =>
    row(...widths.map((width) => cell({ colwidth: width === null ? null : [width] })));

// Mounted on a page whose text column is COLUMN_PX wide, as the editor mounts it.
async function mount(rows: object[]) {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['table'] }), EditorTable, TableWidthClamp],
        content: { type: 'doc', content: [{ type: 'table', content: rows }] },
    });
    editor.registerPlugin(history());
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

const colStyles = (editor: InstanceType<typeof Editor>) =>
    [...editor.view.dom.querySelectorAll<HTMLTableColElement>('col')].map((col) => col.style.width);

// A drag of the right border of the cell at `cellPos` by `dx`: the handle columnResizing sets on hover, mousedown on
// the editor, a move and the mouseup on the window.
function drag(editor: InstanceType<typeof Editor>, cellPos: number, dx: number) {
    const { view } = editor;
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPos }));
    view.dom.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 + dx, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300 + dx }));
}

// Cell positions: table at 0, row at 1, its cells at 2, 7 and 12 ("x" in a paragraph is 5 long).
const [first, second, third] = [2, 7, 12];

test('a border between two columns moves width from one to the other, in every row', async () => {
    const editor = await mount([widthRow(100, 100, 100), widthRow(100, 100, 100)]);
    drag(editor, first, 50);
    expect(widths(editor)).toEqual([[150], [50], [100], [150], [50], [100]]);
    drag(editor, second, -20);
    expect(widths(editor)).toEqual([[150], [30], [120], [150], [30], [120]]);
});

test('a border stops where either column reaches the floor', async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    drag(editor, first, 500);
    expect(widths(editor)).toEqual([[200 - MIN_TABLE_COLUMN_PX], [MIN_TABLE_COLUMN_PX], [100]]);
    drag(editor, first, -500);
    expect(widths(editor)).toEqual([[MIN_TABLE_COLUMN_PX], [200 - MIN_TABLE_COLUMN_PX], [100]]);
});

test("the table's right edge sets its width, up to the text column", async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    drag(editor, third, 100);
    expect(widths(editor)).toEqual([[100], [100], [200]]);
    drag(editor, third, 1000);
    expect(widths(editor)).toEqual([[100], [100], [COLUMN_PX - 200]]);
    drag(editor, third, -1000);
    expect(widths(editor)).toEqual([[100], [100], [MIN_TABLE_COLUMN_PX]]);
});

test('a cell spanning both columns keeps its width and splits it anew', async () => {
    // The spanning cell at 2, then 7; the second row at 13, its cells at 14, 19 and 24.
    const editor = await mount([
        row(cell({ colspan: 2, colwidth: [100, 100] }), cell({ colwidth: [100] })),
        widthRow(100, 100, 100),
    ]);
    drag(editor, 14, 40);
    expect(widths(editor)).toEqual([[140, 60], [100], [140], [60], [100]]);
    // The spanning cell's own right border is the border between the second and third columns.
    drag(editor, first, 20);
    expect(widths(editor)).toEqual([[140, 80], [80], [140], [80], [80]]);
});

test("the first drag stores every column's drawn width, and undo draws the columns as before", async () => {
    const editor = await mount([widthRow(null, null, null)]);
    for (const td of editor.view.dom.querySelectorAll('td')) {
        Object.defineProperty(td, 'offsetWidth', { value: 200 });
    }
    expect(colStyles(editor)).toEqual(['', '', '']);
    drag(editor, first, 50);
    expect(widths(editor)).toEqual([[250], [150], [200]]);
    expect(colStyles(editor)).toEqual(['250px', '150px', '200px']);

    undo(editor.state, editor.view.dispatch);
    expect(widths(editor)).toEqual([null, null, null]);
    expect(colStyles(editor)).toEqual(['', '', '']);
});

test('a move draws the columns the drop writes', async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    const { view } = editor;
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: first }));
    view.dom.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 330, buttons: 1 }));
    expect(colStyles(editor)).toEqual(['130px', '70px', '100px']);
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 330 }));
    expect(widths(editor)).toEqual([[130], [70], [100]]);
});
