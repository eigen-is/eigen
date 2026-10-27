// Google Docs' column drag: the border between two columns moves width from one to the other and the table keeps its
// width, each column stopping at the floor; the table's right edge sets the table's width, up to the block it sits in.
// The first drag on a table stores every column's drawn width, and undoing it draws the columns as before; a click
// writes nothing. Distribute columns gives every column one width, the table's own or, with a column of no width, the
// text column's.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { history, undo, undoDepth } = await import('@tiptap/pm/history');
const { Slice } = await import('@tiptap/pm/model');
const { columnResizingPluginKey } = await import('@tiptap/pm/tables');
const { getDocExtensions, MIN_TABLE_COLUMN_PX } = await import('@workspace/lib/docs/eigendoc');
const { EditorTable } = await import('../../../../components/docs/extensions/table');
const { TableWidthClamp } = await import('../../../../components/docs/extensions/table-width-clamp');

let unmount = async () => {};
afterEach(() => unmount());

const COLUMN_PX = 600;

type CellAttrs = { colspan?: number; rowspan?: number; colwidth: number[] | null };
const cell = (attrs: CellAttrs) => ({
    type: 'tableCell',
    attrs,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
});
const row = (...cells: object[]) => ({ type: 'tableRow', content: cells });
const widthRow = (...widths: (number | null)[]) =>
    row(...widths.map((width) => cell({ colwidth: width === null ? null : [width] })));

const PAPER_PX = 800;

// Mounted on a page whose text column is COLUMN_PX wide, as the editor mounts it, on PAPER_PX of paper.
async function mountDoc(content: object[], pageless = false) {
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['table'] }),
            EditorTable.configure({ pageless: () => pageless, paperWidth: () => PAPER_PX }),
            TableWidthClamp.configure({ paperWidth: () => PAPER_PX }),
        ],
        content: { type: 'doc', content },
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

const mount = (rows: object[], pageless = false) => mountDoc([{ type: 'table', content: rows }], pageless);

const widths = (editor: InstanceType<typeof Editor>) => {
    const found: (number[] | null)[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') found.push(node.attrs['colwidth']);
    });
    return found;
};

const colStyles = (editor: InstanceType<typeof Editor>) =>
    [...editor.view.dom.querySelectorAll<HTMLTableColElement>('col')].map((col) => col.style.width);

// Every cell draws `px` wide, as a laid-out page would draw it.
const drawCells = (editor: InstanceType<typeof Editor>, px: number) => {
    for (const td of editor.view.dom.querySelectorAll('td')) Object.defineProperty(td, 'offsetWidth', { value: px });
};

// A press on the right border of the cell at `cellPos`: the handle columnResizing sets on hover, then mousedown on the
// editor at x 300. The moves and the mouseup go to the window.
function press(editor: InstanceType<typeof Editor>, cellPos: number, init: MouseEventInit = {}) {
    const { view } = editor;
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPos }));
    view.dom.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 300, button: 0, bubbles: true, cancelable: true, ...init }),
    );
}
const move = (dx: number, buttons = 1) =>
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 + dx, buttons }));
const release = (dx: number, button = 0) =>
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300 + dx, button }));

function drag(editor: InstanceType<typeof Editor>, cellPos: number, dx: number) {
    press(editor, cellPos);
    move(dx);
    release(dx);
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

test('a cell spanning both rows is written once, and the cells beside it in each row take their widths', async () => {
    const editor = await mount([
        row(cell({ rowspan: 2, colwidth: [100] }), cell({ colwidth: [100] }), cell({ colwidth: [100] })),
        row(cell({ colwidth: [100] }), cell({ colwidth: [100] })),
    ]);
    let steps = 0;
    editor.on('transaction', ({ transaction }) => {
        steps += transaction.steps.length;
    });
    drag(editor, first, 50);
    expect(widths(editor)).toEqual([[150], [50], [100], [50], [100]]);
    expect(steps).toBe(3);
});

test("the first drag stores every column's drawn width, and undo draws the columns as before", async () => {
    const editor = await mount([widthRow(null, null, null)]);
    drawCells(editor, 200);
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
    press(editor, first);
    move(30);
    expect(colStyles(editor)).toEqual(['130px', '70px', '100px']);
    release(30);
    expect(widths(editor)).toEqual([[130], [70], [100]]);
});

test('a click or a right-click on a border writes nothing and draws the columns as before', async () => {
    const editor = await mount([widthRow(null, null, null)]);
    drawCells(editor, 200);
    press(editor, first, { button: 2 });
    move(40, 2);
    release(40, 2);
    expect(widths(editor)).toEqual([null, null, null]);
    // macOS's right-click: the primary button with control.
    press(editor, first, { ctrlKey: true });
    move(40);
    release(40);
    expect(widths(editor)).toEqual([null, null, null]);
    press(editor, first);
    move(0);
    release(0);
    expect(widths(editor)).toEqual([null, null, null]);
    expect(colStyles(editor)).toEqual(['', '', '']);
});

test('a drag back to where it started writes nothing and draws the columns as before', async () => {
    const editor = await mount([widthRow(null, null, null), widthRow(null, null, null)]);
    drawCells(editor, 200);
    press(editor, first);
    move(40);
    expect(colStyles(editor)).not.toEqual(['', '', '']);
    // A collaborator deletes the row the handle is on, so columnResizing drops its handle.
    editor
        .chain()
        .setTextSelection(first + 2)
        .deleteRow()
        .run();
    move(0);
    release(0);
    expect(widths(editor)).toEqual([null, null, null]);
    expect(colStyles(editor)).toEqual(['', '', '']);
});

test('the drop reads the table again: a column deleted meanwhile keeps its widths, a row added takes them', async () => {
    const deleted = await mount([widthRow(100, 100, 100)]);
    press(deleted, first);
    move(30);
    deleted
        .chain()
        .setTextSelection(third + 2)
        .deleteColumn()
        .run();
    move(40);
    release(40);
    expect(widths(deleted)).toEqual([[100], [100]]);
    expect(colStyles(deleted)).toEqual(['100px', '100px']);
    await unmount();

    const added = await mount([widthRow(100, 100, 100)]);
    press(added, first);
    move(30);
    added
        .chain()
        .setTextSelection(first + 2)
        .addRowAfter()
        .run();
    release(30);
    expect(widths(added)).toEqual([[130], [70], [100], [130], [70], [100]]);
});

// A collaborator's change reaches the editor through y-tiptap as one replace of the whole document.
test("the drop writes its widths after a collaborator's change replaced the whole document", async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    const { view } = editor;
    press(editor, first);
    move(30);
    view.dispatch(view.state.tr.replace(0, view.state.doc.content.size, new Slice(view.state.doc.content, 0, 0)));
    // The replace drops columnResizing's handle; set back, it shows whether a hover still gets through.
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: first }));
    view.dom
        .querySelectorAll('td')[1]
        ?.dispatchEvent(new MouseEvent('mousemove', { clientX: 340, buttons: 1, bubbles: true }));
    expect(columnResizingPluginKey.getState(view.state)?.activeHandle).toBe(first);
    move(40);
    release(40);
    expect(widths(editor)).toEqual([[140], [60], [100]]);
    expect(colStyles(editor)).toEqual(['140px', '60px', '100px']);
});

test('the drop finds the table a paragraph moved, and a table deleted meanwhile takes nothing', async () => {
    const moved = await mount([widthRow(100, 100, 100)]);
    press(moved, first);
    move(30);
    moved.commands.insertContentAt(0, { type: 'paragraph', content: [{ type: 'text', text: 'above' }] });
    release(30);
    expect(widths(moved)).toEqual([[130], [70], [100]]);
    await unmount();

    const deleted = await mountDoc([{ type: 'paragraph' }, { type: 'table', content: [widthRow(100, 100, 100)] }]);
    press(deleted, first + 2);
    move(30);
    deleted
        .chain()
        .setTextSelection(first + 4)
        .deleteTable()
        .run();
    expect(deleted.view.dom.querySelector('table')).toBeNull();
    const doc = deleted.state.doc;
    // happy-dom reports a listener's throw as the window's error event.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    release(30);
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(deleted.state.doc).toBe(doc);
});

test("columnResizing's hover leaves the handle where the drag started", async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    const { view } = editor;
    press(editor, first);
    view.dom
        .querySelectorAll('td')[1]
        ?.dispatchEvent(new MouseEvent('mousemove', { clientX: 330, buttons: 1, bubbles: true }));
    view.dom.dispatchEvent(new MouseEvent('mouseleave'));
    expect(columnResizingPluginKey.getState(view.state)?.activeHandle).toBe(first);
    release(30);
    expect(widths(editor)).toEqual([[130], [70], [100]]);
});

test('a move with no button down, its mouseup lost, ends the drag at the last move with the button down', async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    press(editor, first);
    move(30);
    move(60, 0);
    release(80);
    expect(widths(editor)).toEqual([[130], [70], [100]]);
});

test('a viewer drags nothing', async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    editor.setEditable(false);
    drag(editor, first, 50);
    expect(widths(editor)).toEqual([[100], [100], [100]]);
});

test("on a page drawn at half size a drag moves the border twice as far in the page's pixels", async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    const table = editor.view.dom.querySelector('table');
    if (!table) throw new Error('no table');
    Object.defineProperty(table, 'offsetWidth', { value: 300 });
    Object.defineProperty(table, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 150, 20) });
    drag(editor, third, 100);
    expect(widths(editor)).toEqual([[100], [100], [300]]);
});

test("a table in a list item grows up to the list item's width", async () => {
    // The list at 0, its item at 1, an empty paragraph at 2, the table at 4, its row at 5, its cells at 6, 11 and 16.
    const editor = await mountDoc([
        {
            type: 'bulletList',
            content: [
                {
                    type: 'listItem',
                    content: [{ type: 'paragraph' }, { type: 'table', content: [widthRow(100, 100, 100)] }],
                },
            ],
        },
    ]);
    const item = editor.view.dom.querySelector('li');
    if (!item) throw new Error('no list item');
    Object.defineProperty(item, 'clientWidth', { value: 400 });
    drag(editor, 16, 1000);
    expect(widths(editor)).toEqual([[100], [100], [200]]);
});

test("a page-less doc's table grows past the text column by its right edge, each column up to the paper", async () => {
    const editor = await mount([widthRow(100, 100, 100)], true);
    drag(editor, third, 500);
    expect(widths(editor)).toEqual([[100], [100], [600]]);
    // The drag itself stops at the paper, so what it draws is what it writes.
    press(editor, third);
    move(1000);
    expect(colStyles(editor)).toEqual(['100px', '100px', `${PAPER_PX}px`]);
    release(1000);
    expect(widths(editor)).toEqual([[100], [100], [PAPER_PX]]);
    // A border between two columns still moves width between them, neither past the paper.
    drag(editor, second, 1000);
    expect(widths(editor)).toEqual([[100], [PAPER_PX], [100]]);
});

test("a page-less doc's table in a list item still grows only up to the list item's width", async () => {
    const editor = await mountDoc(
        [
            {
                type: 'bulletList',
                content: [
                    {
                        type: 'listItem',
                        content: [{ type: 'paragraph' }, { type: 'table', content: [widthRow(100, 100, 100)] }],
                    },
                ],
            },
        ],
        true,
    );
    const item = editor.view.dom.querySelector('li');
    if (!item) throw new Error('no list item');
    Object.defineProperty(item, 'clientWidth', { value: 400 });
    drag(editor, 16, 1000);
    expect(widths(editor)).toEqual([[100], [100], [200]]);
});

test('Distribute columns keeps a wide page-less table at its own width', async () => {
    const editor = await mount([row(cell({ colwidth: [700] }), cell({ colwidth: [500] }))], true);
    editor.commands.setTextSelection(first + 2);
    expect(editor.commands.distributeColumns()).toBe(true);
    expect(widths(editor)).toEqual([[600], [600]]);
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

test('Distribute columns leaves a table whose columns are already one width as it is', async () => {
    const editor = await mount([widthRow(100, 100, 100)]);
    editor.commands.setTextSelection(first + 2);
    const [before, depth] = [editor.state.doc, undoDepth(editor.state)];
    expect(editor.commands.distributeColumns()).toBe(true);
    expect(editor.state.doc).toBe(before);
    expect(undoDepth(editor.state)).toBe(depth);
});

test('Distribute columns does nothing outside a table', async () => {
    const editor = await mount([widthRow(100)]);
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(editor.commands.distributeColumns()).toBe(false);
});
