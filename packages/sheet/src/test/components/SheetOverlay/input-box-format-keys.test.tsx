// While a cell is open for editing, ⌘B, ⌘I and ⌘U format the selected characters, not the cell, and the
// browser never gets to insert its own <b>, <i> or <u>. In a formula they format the cell, as before.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
    const update = (recipe: (ctx: Context) => void) =>
        act(() => {
            context = produce(context, recipe);
            render();
        });
    return { input, update, cell: () => context.sheets[0].data?.[0][0] };
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

function selectWord(word: Node | null | undefined) {
    if (!word?.textContent) throw new Error('no word to select');
    const range = document.createRange();
    range.setStart(word, 0);
    range.setEnd(word, word.textContent.length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
}

// The shortcut modifier: ⌘ on a Mac, Ctrl elsewhere, as the hotkey matcher reads the platform.
const MOD = /mac/i.test(`${navigator.platform} ${navigator.userAgent}`) ? { metaKey: true } : { ctrlKey: true };

function press(input: HTMLElement, code: string, letter = code.at(-1)?.toLowerCase()) {
    const key = new KeyboardEvent('keydown', {
        code,
        key: letter,
        ...MOD,
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

// On a Dvorak layout the physical N key types b.
test('the shortcuts follow the letter the layout types, not the physical key', async () => {
    const { input } = await openEditor('hello big world');
    select(input, 6, 9);
    expect(press(input, 'KeyN', 'b').defaultPrevented).toBe(true);
    // Caps Lock types the capital letter.
    expect(press(input, 'KeyF', 'U').defaultPrevented).toBe(true);
    expect(committedRuns(input, null).map(({ v, bl, it, un }) => [v, bl, it, un])).toEqual([
        ['hello ', 0, 0, 0],
        ['big', 1, 0, 1],
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

test('text typed over a selected bold word is bold', async () => {
    const { input } = await openEditor('hello <span style="font-weight: bold">big</span> world');
    selectWord(input.querySelector('span')?.firstChild);
    const typing = new InputEvent('beforeinput', { inputType: 'insertText', data: 'Z', cancelable: true });
    act(() => {
        input.dispatchEvent(typing);
    });
    expect(typing.defaultPrevented).toBe(true);
    expect(committedRuns(input, null).map(({ v, bl }) => [v, bl])).toEqual([
        ['hello ', 0],
        ['Z', 1],
        [' world', 0],
    ]);
});

test('⌘B in a formula bolds the cell and leaves the formula text alone', async () => {
    const { input, cell } = await openEditor('=SUM(');
    select(input, 5);
    expect(press(input, 'KeyB').defaultPrevented).toBe(true);
    expect(input.innerHTML).toBe('=SUM(');
    expect(cell()?.bl).toBe(1);
});

test('a caret format does not carry into the next cell the editor opens on', async () => {
    const { input, update } = await openEditor('hello world');
    select(input, 6);
    press(input, 'KeyB');
    // Escape hands the focus, and the selection with it, back to the grid.
    const grid = document.createElement('div');
    grid.textContent = 'grid';
    document.body.append(grid);
    select(grid, 0);
    update((ctx) => {
        ctx.editingCellPosition = [];
    });
    // The next cell opens with its caret at the end, where the format waited in the last one.
    update((ctx) => {
        ctx.sheets[0].data = [[null, { v: 'hello ', m: 'hello ' }]];
        ctx.selections = [{ row: [0, 0], column: [1, 1], row_focus: 0, column_focus: 1 }];
        ctx.editingCellPosition = [0, 1];
    });
    expect(input.textContent).toBe('hello ');
    const typing = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true });
    act(() => {
        input.dispatchEvent(typing);
    });
    expect(typing.defaultPrevented).toBe(false);
});

// As in Google Sheets: a paste into the open editor is its plain text, typed in the style at the caret.
describe('paste while a cell is open', () => {
    const inserted: string[] = [];
    beforeEach(() => {
        inserted.length = 0;
        document.execCommand = (command, _showUI, value) => {
            if (command === 'insertText' && value !== undefined) inserted.push(value);
            return true;
        };
    });
    afterEach(() => {
        Reflect.deleteProperty(document, 'execCommand');
    });

    function paste(input: HTMLElement, html: string, text: string) {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/html', html);
        clipboardData.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
        act(() => {
            input.dispatchEvent(event);
        });
        return event;
    }

    test('inserts the plain text, not the markup', async () => {
        const { input } = await openEditor('hello ');
        select(input, 6);
        expect(paste(input, '<div><font color="red"><b>big</b></font><br></div>', 'big').defaultPrevented).toBe(true);
        expect(inserted).toEqual(['big']);
    });

    test('over a selected bold word is bold', async () => {
        const { input } = await openEditor('hello <span style="font-weight: bold">big</span> world');
        selectWord(input.querySelector('span')?.firstChild);
        paste(input, '<i>Z</i>', 'Z');
        expect(inserted).toEqual([]);
        expect(committedRuns(input, null).map(({ v, bl }) => [v, bl])).toEqual([
            ['hello ', 0],
            ['Z', 1],
            [' world', 0],
        ]);
    });

    test('types in a caret format waiting at the caret', async () => {
        const { input } = await openEditor('hello world');
        select(input, 6);
        press(input, 'KeyB');
        paste(input, '<i>big </i>', 'big ');
        expect(inserted).toEqual([]);
        expect(committedRuns(input, null).map(({ v, bl }) => [v, bl])).toEqual([
            ['hello ', 0],
            ['big ', 1],
            ['world', 0],
        ]);
    });
});
