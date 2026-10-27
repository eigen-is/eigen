// While a cell is open for editing, ⌘B, ⌘I and ⌘U format the selected characters, not the cell, and the
// browser never gets to insert its own <b>, <i> or <u>. In a formula they format the cell, as before.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { produce } = await import('immer');
const { WorkbookContext } = await import('../../../context');
const { InputBox } = await import('../../../components/SheetOverlay/InputBox');
const { defaultContext, defaultSettings, committedRuns, FormulaCache } = await import('../../../state');
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

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// An InputBox editing A1 of an empty sheet, its recipes applied the way the Workbook applies them.
async function openEditor(text: string) {
    let context: Context = {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config: {}, data: [[null, null]] }],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [0, 0],
        formulaCache: new FormulaCache(),
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        setContext: (recipe: (ctx: Context) => void) => {
                            context = produce(context, recipe);
                            render();
                        },
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                    },
                },
                createElement(InputBox),
            ),
        );
    await act(async () => render());
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('the cell editor did not render');
    input.innerHTML = text;
    return { input, cell: () => context.sheets[0].data?.[0][0] };
}

function select(input: HTMLElement, start: number, end = start) {
    const text = input.firstChild;
    if (!text) throw new Error('the editor holds no text');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
}

function press(input: HTMLElement, code: string) {
    const key = new KeyboardEvent('keydown', {
        code,
        key: code.at(-1)?.toLowerCase(),
        metaKey: true,
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        input.dispatchEvent(key);
    });
    return key;
}

test('⌘B, ⌘I and ⌘U format the selected word, not the browser', async () => {
    const { input } = await openEditor('hello big world');
    select(input, 6, 9);
    for (const code of ['KeyB', 'KeyI', 'KeyU']) expect(press(input, code).defaultPrevented).toBe(true);
    expect(committedRuns(input, null).map(({ v, bl, it, un }) => [v, bl, it, un])).toEqual([
        ['hello ', 0, 0, 0],
        ['big', 1, 1, 1],
        [' world', 0, 0, 0],
    ]);
});

test('⌘B on a caret bolds what is typed next', async () => {
    const { input } = await openEditor('hello world');
    select(input, 6);
    press(input, 'KeyB');
    const typing = new InputEvent('beforeinput', { inputType: 'insertText', data: 'big ', cancelable: true });
    act(() => {
        input.dispatchEvent(typing);
    });
    expect(typing.defaultPrevented).toBe(true);
    expect(committedRuns(input, null).map(({ v, bl }) => [v, bl])).toEqual([
        ['hello ', 0],
        ['big ', 1],
        ['world', 0],
    ]);
});

test('⌘B in a formula bolds the cell and leaves the formula text alone', async () => {
    const { input, cell } = await openEditor('=SUM(');
    select(input, 5);
    expect(press(input, 'KeyB').defaultPrevented).toBe(true);
    expect(input.innerHTML).toBe('=SUM(');
    expect(cell()?.bl).toBe(1);
});
