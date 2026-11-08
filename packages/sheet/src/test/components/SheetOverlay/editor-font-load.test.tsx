// Each face loads only the unicode-range slices its text needs, and a wrapped cell's row height is measured once,
// as it commits. So both editors of a cell, the cell editor and the fx box, load its font for the text as it is
// typed, and the slice is there by the time the commit measures it.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const loads: [string, string | undefined][] = [];
beforeEach(() => {
    loads.length = 0;
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: {
            load: async (font: string, text?: string) => {
                loads.push([font, text]);
                return [];
            },
        },
    });
});

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkbookContext } = await import('../../../context');
const { InputBox } = await import('../../../components/SheetOverlay/InputBox');
const { FxEditor } = await import('../../../components/FxEditor');
const { defaultContext, defaultSettings, FormulaCache, getFontSet } = await import('../../../state');
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

// A wrapped cell in a bold serif, so its font set is not the sheet default.
const CELL = { v: '', m: '', ff: 'Source Serif 4', bl: 1, fs: 14, tb: '2' };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// Opens A1 for editing in `editor` and returns its editable box.
async function openEditor(editor: typeof InputBox | typeof FxEditor, id: string) {
    const context: Context = {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config: {}, data: [[CELL]] }],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
        editingCellPosition: [0, 0],
        formulaCache: new FormulaCache(),
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        getContext: () => context,
                        setContext: () => {},
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                        pasteClipboard: () => {},
                    },
                },
                createElement(editor),
            ),
        ),
    );
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>(`#${id}`);
    if (!input) throw new Error('the editor did not render');
    return input;
}

function type(input: HTMLElement, text: string) {
    input.innerHTML = text;
    act(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

test("typing CJK into the cell editor loads the cell's font for that text", async () => {
    type(await openEditor(InputBox, 'sheet-rich-text-editor'), '你好世界');
    expect(loads).toContainEqual([getFontSet(CELL), '你好世界']);
});

test("typing CJK into the fx box loads the cell's font for that text", async () => {
    type(await openEditor(FxEditor, 'sheet-functionbox-cell'), '你好世界');
    expect(loads).toContainEqual([getFontSet(CELL), '你好世界']);
});
