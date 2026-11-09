import { produce } from 'immer';
import type { Context, SheetConfig } from '../../../state/index';
import { defaultContext, FormulaCache } from '../../../state/index';

// Runs an edit as the app runs it, in a recipe, and leaves the next state in ctx for the test to read.
export function editInPlace(ctx: Context, recipe: (draft: Context) => void) {
    Object.assign(ctx, produce(ctx, recipe));
}

export function selectionFactory(row: number[], column: number[], row_focus: number, column_focus: number) {
    return [
        {
            row,
            column,
            row_focus,
            column_focus,
        },
    ];
}

function refsFactory() {
    return {
        globalCache: {
            undoList: [],
            redoList: [],
            scrollLeft: 0,
            scrollTop: 0,
            scrollListeners: new Set<() => void>(),
        },
        cellInput: { current: null },
        fxInput: { current: null },
        canvas: { current: null },
        cellArea: { current: null },
        workbookContainer: { current: null },
        hooks: { current: {} },
    };
}

// `config` seeds the first sheet's config — the one place a sheet config lives.
export function contextFactory({
    config = {},
    ...params
}: Partial<Context> & { config?: SheetConfig } = {}): Partial<Context> {
    const refs = refsFactory();
    return {
        getRefs: () => refs,
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                config,
                data: [
                    [null, null, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                ],
                order: 0,
            },
            {
                name: 'sheet',
                id: 'id_2',
                data: [
                    [null, null, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                ],
                order: 1,
            },
        ],
        currentSheetId: 'id_1',
        allowEdit: true,
        selections: [
            {
                row: [0, 0],
                column: [1, 1],
                row_focus: 0,
                column_focus: 0,
            },
        ],
        editingCellPosition: [0, 0],
        visibledatarow: [20, 40, 60, 80, 100],
        visibledatacolumn: [74, 148, 222, 296, 370],
        scrollLeft: 0,
        scrollTop: 0,
        sheetViewRecord: {},
        shiftKeyDown: false,
        formulaCache: new FormulaCache(),
        defaultCell: {},
        ...params,
    };
}

// A whole context, for code typed to take one: the editor's defaults under contextFactory's fields.
export function workbookContextFactory(params: Partial<Context> & { config?: SheetConfig } = {}): Context {
    const refs = refsFactory();
    return { ...defaultContext(refs), ...contextFactory({ getRefs: () => refs, ...params }) };
}
