import { type Context, FormulaCache } from '../../../state/index';

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

export function contextFactory({ ...params }: Partial<Context> = {}): Partial<Context> {
    // The Workbook seeding effect assigns `draftCtx.config = sheet.config`, so the mirror and
    // the current sheet's config are one object — alias them here, not two clones. Tests that
    // drive a recipe through produceWithPatches see two independent drafts either way, which
    // is exactly what a sheet-only or mirror-only write has to be caught on.
    const config = params.config ?? {};
    return {
        currentSheetId: 'id_1',
        allowEdit: true,
        config,
        selections: [
            {
                row: [0, 0],
                column: [1, 1],
                row_focus: 0,
                column_focus: 0,
            },
        ],
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
