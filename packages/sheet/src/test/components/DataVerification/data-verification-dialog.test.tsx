// The data-validation dialog over a column header's selection names it B:B and puts the rule on the whole column, to
// the grid's last row. Its delete takes a range out of a rule and keeps the rest.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { produce } = await import('immer');
const { REFERENCE_ROW_COUNT } = await import('@workspace/lib/sheets');
const { WorkbookContext } = await import('../../../context');
const { DataVerification } = await import('../../../components/DataVerification');
const { Dialog, DialogContent } = await import('@workspace/ui/components/dialog');
const { defaultContext, defaultSettings, FormulaCache } = await import('../../../state');
type Context = import('../../../state').Context;
type Selection = import('../../../state').Selection;

const LAST = REFERENCE_ROW_COUNT - 1;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});
const LIST = { type: 'dropdown', type2: '', value1: 'Yes,No', value2: '' };

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

// The dialog over a 1,000-row sheet, its context kept here as the Workbook keeps it.
async function openDialog(selection: Selection, dataValidations = {}) {
    let context: Context = {
        ...defaultContext(refs),
        sheets: [
            {
                id: 'id_1',
                name: 'Sheet1',
                order: 0,
                config: {},
                data: Array.from({ length: 1000 }, () => [null, null, null]),
                dataValidations,
            },
        ],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: [selection],
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
                        getContext: () => context,
                        setContext: (recipe: (ctx: Context) => void) => {
                            context = produce(context, recipe);
                        },
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                    },
                },
                createElement(
                    Dialog,
                    { open: true },
                    createElement(DialogContent, null, createElement(DataVerification)),
                ),
            ),
        );
    await act(async () => render());
    await act(async () => render());
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return {
        context: () => context,
        edit: (recipe: (ctx: Context) => void) => {
            context = produce(context, recipe);
        },
        press: async (label: string) => {
            const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
            await act(async () => button?.click());
        },
    };
}

test('a column header selection is named B:B, and its rule covers the whole column', async () => {
    const dialog = await openDialog({
        row: [0, 999],
        column: [1, 1],
        row_focus: 0,
        column_focus: 1,
        column_select: true,
    });
    expect(dialog.context().validationDraft.rangeTxt).toBe('B:B');
    dialog.edit((ctx) => {
        ctx.validationDraft.value1 = 'Yes,No';
    });
    await dialog.press('OK');
    expect(Object.values(dialog.context().sheets[0].dataValidations ?? {})).toMatchObject([
        { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: { type: 'dropdown', value1: 'Yes,No' } },
    ]);
});

test("opening on a rule's cell reads the rule, and delete takes its range out of the rule", async () => {
    const dialog = await openDialog(
        { row: [2, 2], column: [1, 1], row_focus: 2, column_focus: 1 },
        { v: { ranges: [{ row: [0, LAST], column: [1, 1] }], rule: LIST } },
    );
    expect(dialog.context().validationDraft).toMatchObject({ rangeTxt: 'B3', value1: 'Yes,No' });
    dialog.edit((ctx) => {
        ctx.validationDraft.rangeTxt = 'B2:B3';
    });
    await dialog.press('Delete verification');
    expect(dialog.context().sheets[0].dataValidations).toEqual({
        v: {
            ranges: [
                { row: [0, 0], column: [1, 1] },
                { row: [3, LAST], column: [1, 1] },
            ],
            rule: LIST,
        },
    });
});
