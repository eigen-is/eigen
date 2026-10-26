// A rich-text cell keeps its text in its runs alone, no `v` or `m` (engine/format.ts). Every reader of a cell's
// text reads it through richText or cellValue, so a rich cell, imported or typed, is never read as empty. Every
// writer that writes plain text drops the runs, which would otherwise outrank what it wrote.

import { describe, expect, test } from 'bun:test';
import { evaluateConditionalFormat } from '../../engine/conditional-format';
import { cellDisplay, cellValue } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import { setCellValue as apiSetCellValue } from '../../state/api/cell';
import type { Context } from '../../state/context';
import { getCellValue, getRealCellValue, setCellValue } from '../../state/modules/cell';
import { getDropdownList, validateCellData } from '../../state/modules/data-verification';
import { buildFilterConditionMatcher, getFilterColumnValues } from '../../state/modules/filter';
import { removeHyperlink, saveHyperlink, showLinkCard } from '../../state/modules/hyperlink';
import { calcSelectionInfo } from '../../state/modules/selection';
import { orderbydata, sortSelection } from '../../state/modules/sort';
import { autoSelectionFormula, handleMerge } from '../../state/modules/toolbar';
import type { GlobalCache } from '../../state/types';
import { contextFactory, selectionFactory } from './factories/context';

function rich(text: string): Cell {
    return { ct: { fa: 'General', t: 'inlineStr', s: [{ v: text.slice(0, 2), bl: 1 }, { v: text.slice(2) }] } };
}

function plain(v: string | number): Cell {
    return { v, m: String(v), ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 'g' } };
}

function sheetContext(data: CellMatrix, selection = selectionFactory([0, 0], [0, 0], 0, 0)) {
    return contextFactory({
        selections: selection,
        sheets: [{ name: 'Sheet1', id: 'id_1', order: 0, data, row: data.length, column: data[0].length }],
    }) as Context;
}

describe('cellValue', () => {
    test('reads a rich cell from its runs and any other from v', () => {
        expect(cellValue(rich('Hello'))).toBe('Hello');
        expect(cellValue(plain(3))).toBe(3);
        expect(cellValue(null)).toBeUndefined();
    });
});

describe('cellDisplay', () => {
    test('reads the runs, else m, else v; an empty m is the display', () => {
        expect(cellDisplay(rich('Hello'))).toBe('Hello');
        expect(cellDisplay({ v: 5, m: '5.00' })).toBe('5.00');
        expect(cellDisplay({ v: 5 })).toBe(5);
        expect(cellDisplay({ v: 5, m: '' })).toBe('');
        expect(cellDisplay(null)).toBeUndefined();
    });
});

describe('readers of a rich cell', () => {
    test('getCellValue and getRealCellValue read the text, so a dropdown over it validates', () => {
        const data = [[rich('Red')]];
        expect(getCellValue(0, 0, data)).toBe('Red');
        expect(getCellValue(0, 0, data, 'm')).toBe('Red');
        const value = getRealCellValue(0, 0, data);
        expect(value).toBe('Red');
        const ctx = sheetContext([[rich('Red'), null]]);
        expect(validateCellData(ctx, { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' }, value)).toBe(
            true,
        );
    });

    test('a dropdown sourced from a range lists the rich cells', () => {
        const ctx = sheetContext([[rich('Alpha')], [plain('Beta')]]);
        expect(getDropdownList(ctx, 'Sheet1!A1:A2')).toEqual(['Alpha', 'Beta']);
    });

    test('a dropdown lists a cell whose display is empty by its value', () => {
        const ctx = sheetContext([[{ v: 5, m: '', ct: { fa: ';;;', t: 'n' } }], [plain('Beta')]]);
        expect(getDropdownList(ctx, 'Sheet1!A1:A2')).toEqual([5, 'Beta']);
    });

    test('conditional formats compare the text', () => {
        const data = [[rich('Hello'), rich('World')]];
        const format = { textColor: '#000000', cellColor: '#ff0000' };
        const styles = evaluateConditionalFormat(
            [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 1] }],
                    format,
                    conditionName: 'textContains',
                    conditionRange: [],
                    conditionValue: ['hell'],
                },
                {
                    type: 'default',
                    cellrange: [{ row: [0, 0], column: [0, 1] }],
                    format: { textColor: '#0000ff', cellColor: '#00ff00' },
                    conditionName: 'equal',
                    conditionRange: [],
                    conditionValue: ['World'],
                },
            ],
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
        expect(styles['0_1']?.cellColor).toBe('#00ff00');
    });

    test('sort orders rich cells by their text and takes a rich first row into the range', () => {
        const { sortedData } = orderbydata(true, 0, [[rich('Cherry')], [plain('apple')], [rich('Banana')]]);
        expect(sortedData.map((row) => cellValue(row[0]))).toEqual(['apple', 'Banana', 'Cherry']);

        const ctx = sheetContext(
            [[rich('Cherry')], [plain('apple')], [rich('Banana')]],
            selectionFactory([0, 2], [0, 0], 0, 0),
        );
        sortSelection(ctx, true, 0);
        expect(ctx.sheets[0].data!.map((row) => cellValue(row[0]))).toEqual(['apple', 'Banana', 'Cherry']);
    });

    test('filter conditions and the value list read the text', () => {
        expect(buildFilterConditionMatcher({ conditionName: 'textContains', values: ['ell'] })(rich('Hello'))).toBe(
            true,
        );
        expect(buildFilterConditionMatcher({ conditionName: 'isEmpty', values: [] })(rich('Hello'))).toBe(false);
        const ctx = sheetContext([[plain('Head')], [rich('Hello')], [plain('x')]]);
        ctx.filter = {};
        const { values } = getFilterColumnValues(ctx, 0, 0, 2, 0);
        expect(values.map((value) => value.text)).toEqual(['Hello', 'x']);
        expect(
            buildFilterConditionMatcher({ conditionName: 'textContains', values: ['5.0'] })({ v: 5, m: '5.00' }),
        ).toBe(true);
    });

    test('the status bar counts rich cells', () => {
        const ctx = sheetContext([[rich('Hello'), plain(2)]], selectionFactory([0, 0], [0, 1], 0, 0));
        expect(calcSelectionInfo(ctx).count).toBe(2);
    });

    test('the link card shows the text', () => {
        const ctx = sheetContext([[rich('Docs')]]);
        ctx.sheets[0].hyperlink = { '0_0': { linkType: 'webpage', linkAddress: 'https://eigen.is' } };
        showLinkCard(ctx, 0, 0);
        expect(ctx.linkCard?.originText).toBe('Docs');
    });

    test('a merge keeps the rich text of its first cell', () => {
        const ctx = sheetContext([[null], [rich('Hello')]], selectionFactory([0, 1], [0, 0], 0, 0));
        ctx.sheets[0].config = {};
        handleMerge(ctx, 'merge-vertical');
        expect(cellValue(ctx.sheets[0].data![0][0])).toBe('Hello');
    });

    test('autosum writes past a rich cell, never over it', () => {
        const ctx = sheetContext(
            [[plain(1)], [plain(2)], [rich('Note')], [null]],
            selectionFactory([0, 1], [0, 0], 0, 0),
        );
        autoSelectionFormula(ctx, {} as HTMLDivElement, null, 'SUM', {} as GlobalCache);
        const d = ctx.sheets[0].data!;
        expect(cellValue(d[2][0])).toBe('Note');
        expect(d[3][0]?.f).toBe('=SUM(A1:A2)');
    });
});

describe('writers over a rich cell', () => {
    test('a plain write into a text-formatted rich cell drops the runs', () => {
        const cell = rich('Hello');
        cell.ct!.fa = '@';
        const data: CellMatrix = [[cell]];
        setCellValue(sheetContext(data), 0, 0, data, 'plain');
        expect(data[0][0]?.ct?.s).toBeUndefined();
        expect(cellValue(data[0][0])).toBe('plain');
        expect(data[0][0]?.ct?.fa).toBe('@');
    });

    test('a formula result written over a rich cell drops the runs', () => {
        const data: CellMatrix = [[rich('Hello')]];
        setCellValue(sheetContext(data), 0, 0, data, { v: 3, f: '=1+2' });
        expect(data[0][0]?.ct?.s).toBeUndefined();
        expect(cellValue(data[0][0])).toBe(3);
    });

    test('a rich write keeps its runs', () => {
        const data: CellMatrix = [[null]];
        setCellValue(sheetContext(data), 0, 0, data, rich('Hello'));
        expect(cellValue(data[0][0])).toBe('Hello');
    });

    test('the API writes a formula over a rich cell', () => {
        const ctx = sheetContext([[plain('Hi'), rich('Hello')]]);
        apiSetCellValue(ctx, 0, 1, '=A1&"!"', null);
        const cell = ctx.sheets[0].data![0][1];
        expect(cell?.ct?.s).toBeUndefined();
        expect(cellValue(cell)).toBe('Hi!');
    });

    test('a link saved with new text writes it plain; one saved with the same text keeps the runs', () => {
        const ctx = sheetContext([[rich('Hello'), rich('Docs')]]);
        saveHyperlink(ctx, 0, 0, 'Other', 'webpage', 'https://eigen.is');
        const renamed = ctx.sheets[0].data![0][0];
        expect(renamed?.ct?.s).toBeUndefined();
        expect(cellValue(renamed)).toBe('Other');

        saveHyperlink(ctx, 0, 1, 'Docs', 'webpage', 'https://eigen.is');
        const kept = ctx.sheets[0].data![0][1];
        expect(kept?.ct?.s?.length).toBe(2);
        expect(kept?.v).toBeUndefined();
    });

    test('a link saved over a number with its text unchanged keeps the number', () => {
        const ctx = sheetContext([[plain(5)]]);
        saveHyperlink(ctx, 0, 0, '5', 'webpage', 'https://eigen.is');
        const cell = ctx.sheets[0].data![0][0];
        expect(cell?.v).toBe(5);
        expect(cell?.ct?.t).toBe('n');
        expect(cell?.hl).toBeDefined();
    });

    test('removing a link keeps the rich text', () => {
        const ctx = sheetContext([[rich('Docs')]]);
        saveHyperlink(ctx, 0, 0, 'Docs', 'webpage', 'https://eigen.is');
        removeHyperlink(ctx, 0, 0);
        const cell = ctx.sheets[0].data![0][0];
        expect(cellValue(cell)).toBe('Docs');
        expect(cell?.hl).toBeUndefined();
        expect(cell?.un).toBeUndefined();
    });
});
