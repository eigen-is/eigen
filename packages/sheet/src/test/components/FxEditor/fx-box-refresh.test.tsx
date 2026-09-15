// The fx box shows the focused cell's content, and an undo of an edit to that cell moves nothing
// else: same sheet, same selection, new value. So the refresh cannot key off the selection having
// changed — it has to follow the cell.

import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkbookContext } = await import('../../../context');
const { FxEditor } = await import('../../../components/FxEditor');
const { defaultContext, defaultSettings } = await import('../../../state');
const { FormulaCache } = await import('../../../state');
type Context = import('../../../state').Context;

const refs = {
    globalCache: {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set<() => void>(),
        notifyScrollListeners: () => {},
    },
    cellInput: createRef<HTMLDivElement | null>(),
    fxInput: createRef<HTMLDivElement | null>(),
    canvas: createRef<HTMLCanvasElement | null>(),
    cellArea: createRef<HTMLDivElement | null>(),
    workbookContainer: createRef<HTMLDivElement | null>(),
};

// One selection object shared by every context below: an undo leaves the cursor exactly where it was.
const SELECTIONS = [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }];

function contextShowing(cell: { v?: number; m?: string; f?: string }, editing = false): Context {
    return {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config: {}, data: [[cell]] }],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: SELECTIONS,
        editingCellPosition: editing ? [0, 0] : [],
        formulaCache: new FormulaCache(),
    };
}

function render(root: ReturnType<typeof createRoot>, context: Context) {
    return act(async () => {
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        setContext: () => {},
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                    },
                },
                createElement(FxEditor),
            ),
        );
    });
}

test('the fx box follows an undo that leaves the selection alone', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await render(root, contextShowing({ v: 2, m: '2' }));
    expect(container.querySelector('#sheet-functionbox-cell')?.innerHTML).toBe('2');

    await render(root, contextShowing({ v: 1, m: '1' }));
    expect(container.querySelector('#sheet-functionbox-cell')?.innerHTML).toBe('1');

    await act(async () => root.unmount());
    container.remove();
});

test('a peer edit landing mid-keystroke leaves the open edit alone', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await render(root, contextShowing({ v: 2, m: '2' }));
    const box = container.querySelector('#sheet-functionbox-cell');
    if (!box) throw new Error('fx box did not render');

    // What the user has typed so far, which only the editor writes.
    box.innerHTML = '=SUM(';
    await render(root, contextShowing({ v: 7, m: '7' }, true));
    expect(box.innerHTML).toBe('=SUM(');

    await act(async () => root.unmount());
    container.remove();
});
