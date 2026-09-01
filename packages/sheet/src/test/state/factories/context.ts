import { type Context, FormulaCache, type SheetConfig } from '../../../state/index';

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

// `config` seeds the first sheet's config — the one place a sheet config lives.
export function contextFactory({
    config = {},
    ...params
}: Partial<Context> & { config?: SheetConfig } = {}): Partial<Context> {
    return {
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
        shiftKeyDown: false,
        groupValuesRefreshData: [],
        formulaCache: new FormulaCache(),
        defaultCell: {},
        hooks: {},
        ...params,
    };
}
