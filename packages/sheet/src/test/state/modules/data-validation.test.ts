// Data-validation runtime paths the xlsx importer relies on. The dominant
// imported shape is a dropdown whose value1 is a live quoted cross-sheet
// $-anchored range ref ('MASTER DATA'!$B$2:$B$4) — getDropdownList must keep
// resolving it by sheet NAME. Date rules carry YYYY-MM-DD operand strings.

import { describe, expect, test } from 'bun:test';
import {
    MAX_VALIDATION_RANGES,
    MAX_VALIDATIONS,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
} from '@workspace/lib/sheets';
import { dateToSerial } from '../../../engine/parser/helper/number';
import type { Context } from '../../../state/context';
import {
    applyDataValidation,
    cellPassesRule,
    cellTextBox,
    checkboxAlign,
    checkboxChange,
    checkboxRect,
    DROPDOWN_CHEVRON_HIT_WIDTH,
    dropdownChevronRect,
    getCellDataValidation,
    getDropdownList,
    getValidationHint,
    insertCheckbox,
    isCheckboxChecked,
    isCheckboxClick,
    isDropdownChevronClick,
    validateCellData,
    validationRange,
    validationValueProblem,
} from '../../../state/modules/data-validation';
import {
    addValidation,
    clearValidations,
    validationAt,
    validationLookup,
} from '../../../state/modules/validation-rules';
import type { Cell, DataValidationDraft, DataValidationRule, Sheet } from '../../../state/types';
import { contextFactory, workbookContextFactory } from '../factories/context';
import { cellsWithRules, validationsByCell } from '../factories/validations';

describe('getDropdownList', () => {
    test('resolves a quoted cross-sheet $-anchored range ref by sheet name', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[1].name = 'MASTER DATA';
        ctx.sheets[1].data = [
            [null, null, null, null],
            [null, { v: 'Alpha', m: 'Alpha' }, null, null],
            [null, { v: 'Beta', m: 'Beta' }, null, null],
            [null, { v: 'Beta', m: 'Beta' }, null, null],
        ];
        expect(getDropdownList(ctx, "'MASTER DATA'!$B$2:$B$4")).toEqual(['Alpha', 'Beta']);
    });

    test('splits a comma literal into options', () => {
        const ctx = contextFactory() as Context;
        expect(getDropdownList(ctx, 'Red,Green,Blue')).toEqual(['Red', 'Green', 'Blue']);
    });
});

describe('validateCellData', () => {
    const serial = (date: string) => dateToSerial(new Date(date.replace(/-/g, '/')));

    test('a date rule compares serials, and its operands are YYYY-MM-DD', () => {
        const ctx = contextFactory() as Context;
        const rule: DataValidationRule = {
            type: 'date',
            type2: 'between',
            value1: '2024-01-01',
            value2: '2024-12-31',
        };
        expect(validateCellData(ctx, rule, serial('2024-06-15'))).toBe(true);
        expect(validateCellData(ctx, rule, serial('2025-06-15'))).toBe(false);
        expect(validateCellData(ctx, rule, 'not a date')).toBe(false);
    });

    // Excel's "date >= 1/1/1900" stores serial 1, which the importer writes as 1899-12-31.
    test('an imported any-date rule passes every date', () => {
        const ctx = workbookContextFactory();
        const rule: DataValidationRule = { type: 'date', type2: 'noEarlierThan', value1: '1899-12-31', value2: '' };
        expect(validateCellData(ctx, rule, serial('2024-06-15'))).toBe(true);
    });
});

// Tick boxes. The rule names the value that counts as checked; the cell says
// whether it is. These pin the four defects the feature shipped with: applying
// a rule wiped the range, the box ignored the cell value, any click in the cell
// toggled, and a formula cell was silently replaced with a literal.
const TICK_BOX: DataValidationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };

function tickBoxContext(data: Context['sheets'][number]['data']) {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].data = data;
    ctx.sheets[0].dataValidations = validationsByCell({ '0_0': TICK_BOX, '1_0': TICK_BOX, '2_0': TICK_BOX });
    return ctx;
}

describe('isCheckboxChecked', () => {
    test('reads the cell value, not a flag on the rule', () => {
        expect(isCheckboxChecked(TICK_BOX, true)).toBe(true);
        expect(isCheckboxChecked(TICK_BOX, 'TRUE')).toBe(true);
        // The xlsx importer used to display literal booleans lower-cased.
        expect(isCheckboxChecked(TICK_BOX, 'true')).toBe(true);
        expect(isCheckboxChecked(TICK_BOX, 'FALSE')).toBe(false);
        expect(isCheckboxChecked(TICK_BOX, false)).toBe(false);
        expect(isCheckboxChecked(TICK_BOX, null)).toBe(false);
        expect(isCheckboxChecked(TICK_BOX, '')).toBe(false);
    });

    test('honours a rule with custom selected/not-selected values', () => {
        const rule: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
        expect(isCheckboxChecked(rule, 'Yes')).toBe(true);
        expect(isCheckboxChecked(rule, 'No')).toBe(false);
    });
});

describe('a tick box rule and the value its cell holds', () => {
    const YES_NO: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
    const passes = (rule: DataValidationRule, value: string | number | boolean | null | undefined) =>
        validateCellData(contextFactory() as Context, rule, value);

    test('either value the rule names passes, whatever its case', () => {
        expect([true, false, 'TRUE', 'false'].map((value) => passes(TICK_BOX, value))).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(['Yes', 'No', 'yes'].map((value) => passes(YES_NO, value))).toEqual([true, true, true]);
    });

    test('an empty cell passes, so a fresh range marks nothing', () => {
        expect([null, undefined, ''].map((value) => passes(TICK_BOX, value))).toEqual([true, true, true]);
    });

    test('a value the rule does not name fails, as under any other rule', () => {
        expect(['Yes', 'Maybe', 'n/a', 0].map((value) => passes(TICK_BOX, value))).toEqual([
            false,
            false,
            false,
            false,
        ]);
        expect(['Maybe', 'TRUE', true].map((value) => passes(YES_NO, value))).toEqual([false, false, false]);
    });
});

describe('cellPassesRule', () => {
    test('a number rule reads the value, not the text a format shows', () => {
        const ctx = contextFactory() as Context;
        const over1000: DataValidationRule = { type: 'number', type2: 'moreThanThe', value1: '1000', value2: '' };
        const under1: DataValidationRule = { type: 'number', type2: 'lessThan', value1: '1', value2: '' };
        expect(cellPassesRule(ctx, over1000, { v: 1234.5, m: '1,234.50', ct: { fa: '#,##0.00', t: 'n' } })).toBe(true);
        expect(cellPassesRule(ctx, under1, { v: 0.5, m: '50%', ct: { fa: '0%', t: 'n' } })).toBe(true);
    });
});

describe('checkboxChange', () => {
    test('toggles the cell value and writes a real boolean cell', () => {
        const ctx = tickBoxContext([
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        expect(checkboxChange(ctx, 0, 0)).toBe(true);
        expect(ctx.sheets[0].data![0][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
        expect(checkboxChange(ctx, 0, 0)).toBe(true);
        expect(ctx.sheets[0].data![0][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
    });

    test('leaves a formula cell alone', () => {
        const cell = { v: true, m: 'TRUE', f: '=B1=C1', ct: { fa: 'General', t: 'b' } };
        const ctx = tickBoxContext([
            [cell, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        expect(checkboxChange(ctx, 0, 0)).toBe(false);
        expect(ctx.sheets[0].data![0][0]).toEqual(cell);
    });

    test('leaves a cell holding a value its rule does not name alone, as it shows no box', () => {
        const ctx = tickBoxContext([[{ v: 'Maybe', m: 'Maybe' }, null, null, null]]);
        expect(checkboxChange(ctx, 0, 0)).toBe(false);
        expect(ctx.sheets[0].data![0][0]).toEqual({ v: 'Maybe', m: 'Maybe' });
    });

    test('reports no toggle for a cell without a tick box', () => {
        const ctx = tickBoxContext([
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        expect(checkboxChange(ctx, 3, 3)).toBe(false);
        expect(ctx.sheets[0].data![3][3]).toBeNull();
    });

    test('leaves the rest of the range untouched', () => {
        const ctx = tickBoxContext([
            [{ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [{ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [{ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
        ]);
        checkboxChange(ctx, 1, 0);
        expect(ctx.sheets[0].data![0][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data![1][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data![2][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
    });
});

describe('applyDataValidation', () => {
    test('seeds only empty cells, keeping existing TRUE/FALSE values', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [
            [{ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ];
        applyDataValidation(ctx, { row: [0, 2], column: [0, 0] }, TICK_BOX);

        expect(ctx.sheets[0].data[0][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data[1][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data[2][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(cellsWithRules(ctx.sheets[0].dataValidations)).toEqual(['0_0', '1_0', '2_0']);
    });

    test('never seeds cells for a non-checkbox rule', () => {
        const ctx = contextFactory() as Context;
        const rule: DataValidationRule = { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' };
        applyDataValidation(ctx, { row: [0, 1], column: [0, 0] }, rule);
        expect(ctx.sheets[0].data![0][0]).toBeNull();
        expect(Object.values(ctx.sheets[0].dataValidations ?? {})).toEqual([
            { ranges: [{ row: [0, 1], column: [0, 0] }], rule },
        ]);
    });

    test('stores the rule once over its range, whatever its size', () => {
        const ctx = contextFactory() as Context;
        applyDataValidation(ctx, { row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }, LIST_RULE);
        expect(Object.values(ctx.sheets[0].dataValidations ?? {})).toEqual([
            { ranges: [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }], rule: LIST_RULE },
        ]);
    });

    test('takes its cells out of the rules they had, and drops a rule left with none', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].dataValidations = {
            wide: { ranges: [{ row: [0, 3], column: [0, 1] }], rule: TICK_BOX },
            inside: { ranges: [{ row: [1, 1], column: [0, 0] }], rule: TICK_BOX },
        };
        applyDataValidation(ctx, { row: [1, 2], column: [0, 0] }, LIST_RULE);
        const { wide, inside, ...added } = ctx.sheets[0].dataValidations;
        expect(inside).toBeUndefined();
        expect(wide.ranges).toEqual([
            { row: [0, 0], column: [0, 1] },
            { row: [1, 2], column: [1, 1] },
            { row: [3, 3], column: [0, 1] },
        ]);
        expect(Object.values(added)).toEqual([{ ranges: [{ row: [1, 2], column: [0, 0] }], rule: LIST_RULE }]);
        expect(getCellDataValidation(ctx, 2, 0)).toEqual(LIST_RULE);
        expect(getCellDataValidation(ctx, 2, 1)).toEqual(TICK_BOX);
    });

    test('a whole-column tick box seeds only the rows the sheet has', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [[null], [{ v: 'x', m: 'x' }], [null]];
        applyDataValidation(ctx, { row: [0, REFERENCE_ROW_COUNT - 1], column: [0, 0] }, TICK_BOX);
        expect(ctx.sheets[0].data.map((row) => row[0]?.v ?? null)).toEqual([false, 'x', false]);
    });
});

describe('the rule over a cell', () => {
    test('a whole-column rule applies at row 5000 of a sheet that grew past its first thousand rows', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = Array.from({ length: 6000 }, () => [null, null]);
        ctx.sheets[0].dataValidations = {
            v: { ranges: [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }], rule: LIST_RULE },
        };
        expect(getCellDataValidation(ctx, 4999, 1)).toEqual(LIST_RULE);
        expect(getCellDataValidation(ctx, 4999, 0)).toBeUndefined();
    });

    test('where two rules overlap, the highest id wins on every tab, whatever order the map holds them in', () => {
        const a = { ranges: [{ row: [0, 1], column: [0, 0] }], rule: LIST_RULE };
        const b = { ranges: [{ row: [1, 2], column: [0, 0] }], rule: TICK_BOX };
        for (const validations of [
            { a, b },
            { b, a },
        ]) {
            expect(validationAt(validations, 1, 0)).toEqual(TICK_BOX);
            expect(validationLookup(validations, { row: [0, 5], column: [0, 5] })(1, 0)).toEqual(TICK_BOX);
        }
        // An import numbers its rules in the file's order, and the last one wins.
        const numbered = { 'validation-10': b, 'validation-9': a };
        expect(validationAt(numbered, 1, 0)).toEqual(TICK_BOX);
    });

    // A cell checked every rule's ranges in view: 100 rules of 100 cells each took about 50 ms a frame.
    test("the painter's lookup costs a frame little however many rules are in view", () => {
        const validations = Object.fromEntries(
            Array.from({ length: 100 }, (_, k) => [
                `r${k}`,
                {
                    ranges: Array.from({ length: 100 }, (_, i) => {
                        const [r, c] = [(i * 7 + k) % 61, (k + i) % 26];
                        return { row: [r, r], column: [c, c] };
                    }),
                    rule: k % 2 === 0 ? LIST_RULE : TICK_BOX,
                },
            ]),
        );
        const window = { row: [0, 60], column: [0, 25] };
        const started = performance.now();
        for (let frame = 0; frame < 20; frame += 1) {
            const lookup = validationLookup(validations, window);
            for (let r = 0; r <= 60; r += 1) for (let c = 0; c <= 25; c += 1) lookup(r, c);
        }
        expect(performance.now() - started).toBeLessThan(600);
        const lookup = validationLookup(validations, window);
        for (const [r, c] of [
            [0, 0],
            [7, 1],
            [60, 25],
        ]) {
            expect(lookup(r, c)).toEqual(validationAt(validations, r, c));
        }
    });

    test("the painter's lookup answers as the full lookup does, inside its window and outside it", () => {
        const validations = {
            a: { ranges: [{ row: [0, 9], column: [2, 2] }], rule: LIST_RULE },
            b: {
                ranges: [
                    { row: [3, 3], column: [0, 5] },
                    { row: [20, 30], column: [0, 0] },
                ],
                rule: TICK_BOX,
            },
        };
        const lookup = validationLookup(validations, { row: [2, 6], column: [1, 4] });
        for (let r = 0; r < 32; r += 1) {
            for (let c = 0; c < 7; c += 1) expect(lookup(r, c)).toEqual(validationAt(validations, r, c));
        }
    });
});

// The dialog's range box names a column header's selection as B:B, and a whole column runs to the grid's last row.
// Every peer, the server and a reload drop a rule past the caps, so a writer never makes one: the edit goes through
// and the rule forgets the cells.
describe('a write past the caps', () => {
    const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
    const capSheet = (): Sheet => ({ name: 'sheet', id: 'id_1', order: 0 });

    test('a clear that would split a rule past the ranges a rule may hold drops the rule', () => {
        const sheet = capSheet();
        const rows = Array.from({ length: MAX_VALIDATION_RANGES }, (_, i) => ({ row: [2 * i, 2 * i], column: [0, 2] }));
        sheet.dataValidations = {
            v: { ranges: rows, rule },
            other: { ranges: [{ row: [0, 0], column: [5, 5] }], rule },
        };
        clearValidations(sheet, { row: [0, 0], column: [0, 0] });
        expect(sheet.dataValidations.v.ranges).toHaveLength(MAX_VALIDATION_RANGES);
        clearValidations(sheet, { row: [2, 2], column: [1, 1] });
        expect(Object.keys(sheet.dataValidations)).toEqual(['other']);
    });

    test('a rule at the ranges a rule may hold keeps them and stops extending', () => {
        const sheet = capSheet();
        const rows = Array.from({ length: MAX_VALIDATION_RANGES }, (_, i) => ({ row: [2 * i, 2 * i], column: [0, 0] }));
        sheet.dataValidations = { v: { ranges: rows, rule } };
        addValidation(sheet, 'v', rule, [{ row: [0, 0], column: [5, 5] }]);
        expect(sheet.dataValidations.v.ranges).toEqual(rows);
    });

    test('a new rule on a sheet that holds as many rules as a sheet may is left out, and a grown one is not', () => {
        const sheet = capSheet();
        sheet.dataValidations = Object.fromEntries(
            Array.from({ length: MAX_VALIDATIONS }, (_, i) => [
                `v${i}`,
                { ranges: [{ row: [i, i], column: [0, 0] }], rule },
            ]),
        );
        const range = { row: [0, 0], column: [5, 5] };
        addValidation(sheet, 'new', rule, [range]);
        expect(sheet.dataValidations.new).toBeUndefined();
        addValidation(sheet, 'v0', rule, [range]);
        expect(sheet.dataValidations.v0.ranges).toContainEqual(range);
    });
});

describe('validationRange', () => {
    test('a whole column runs to the last row of the grid, and a whole row to its last column', () => {
        const ctx = contextFactory() as Context;
        expect(validationRange(ctx, 'B:B')).toEqual({ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] });
        expect(validationRange(ctx, '2:3')).toEqual({ row: [1, 2], column: [0, REFERENCE_COLUMN_COUNT - 1] });
        expect(validationRange(ctx, 'B2:C4')).toEqual({ row: [1, 3], column: [1, 2] });
        expect(validationRange(ctx, '')).toBeUndefined();
    });
});

// Insert -> Tick box has no dialog to reconsider the selection in, and a click on
// the column header hands it every row the sheet has (events/mouse-header.ts).
// One rule per cell in the snapshot, so a whole column is bounded to the rows
// that hold something; a range the user dragged out is applied as selected.
describe('insertCheckbox', () => {
    function sheetWithRows(rows: number, usedThrough: number) {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = Array.from({ length: rows }, (_, r) =>
            Array.from({ length: 4 }, (_, c) => (r <= usedThrough && c === 0 ? { v: 'x', m: 'x' } : null)),
        ) as Context['sheets'][number]['data'];
        ctx.visibledatarow = Array.from({ length: rows }, (_, r) => (r + 1) * 20);
        return ctx;
    }

    test('bounds a whole-column selection to the last row that holds data', () => {
        const ctx = sheetWithRows(500, 2);
        ctx.selections = [{ row: [0, 499], column: [0, 0], row_focus: 0, column_focus: 0, column_select: true }];
        insertCheckbox(ctx);
        expect(cellsWithRules(ctx.sheets[0].dataValidations)).toEqual(['0_0', '1_0', '2_0']);
    });

    test('a whole column of an empty sheet still ticks its first cell', () => {
        const ctx = sheetWithRows(500, -1);
        ctx.selections = [{ row: [0, 499], column: [0, 0], row_focus: 0, column_focus: 0, column_select: true }];
        insertCheckbox(ctx);
        expect(cellsWithRules(ctx.sheets[0].dataValidations)).toEqual(['0_0']);
    });

    test('a dragged range is applied as selected, past the used extent', () => {
        const ctx = sheetWithRows(500, 0);
        ctx.selections = [{ row: [0, 3], column: [0, 0], row_focus: 0, column_focus: 0 }];
        insertCheckbox(ctx);
        expect(cellsWithRules(ctx.sheets[0].dataValidations)).toEqual(['0_0', '1_0', '2_0', '3_0']);
    });
});

describe('cellTextBox', () => {
    test('insets the cell by the grid lines it must not paint over', () => {
        expect(cellTextBox(0, 0, 74, 20)).toEqual({ left: 0, top: 1, width: 72, height: 18 });
    });
});

describe('isCheckboxClick', () => {
    // A cell without its own alignment centres the 10px box, at x 31..40, y 5..14.
    const box = cellTextBox(0, 0, 74, 20);

    const YES_NO: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
    const ticked = { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } };
    const oneCell = (cell: Cell, rule: DataValidationRule) => {
        const ctx = tickBoxContext([[cell, null, null, null]]);
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': rule });
        return ctx;
    };

    test('a tick box is centred, as in Google Sheets, unless its cell is aligned', () => {
        const unaligned = [ticked, { ...ticked, v: false, m: 'FALSE' }, null, {}, { v: 'Yes', m: 'Yes' }];
        expect(unaligned.map((cell) => checkboxAlign(cell))).toEqual([0, 0, 0, 0, 0]);
        expect([1, 2, 0].map((ht) => checkboxAlign({ ...ticked, ht }))).toEqual([1, 2, 0]);
        expect([1, 2, 0].map((ht) => checkboxAlign({ v: 'Yes', m: 'Yes', ht }))).toEqual([1, 2, 0]);
    });

    test('a click finds the box of a rule with its own values in the centre, where the painter draws it', () => {
        const ctx = oneCell({ v: 'Yes', m: 'Yes' }, YES_NO);
        expect(isCheckboxClick(ctx, 0, 0, box, 36, 9)).toBe(true);
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(false);
    });

    test('a cell holding a value its rule does not name has no box to click', () => {
        for (const ctx of [oneCell({ v: 'Maybe', m: 'Maybe' }, YES_NO), oneCell({ v: 'Yes', m: 'Yes' }, TICK_BOX)]) {
            expect(isCheckboxClick(ctx, 0, 0, box, 36, 9)).toBe(false);
            expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(false);
        }
    });

    test('places the box by the cell alignment', () => {
        expect(checkboxRect(box, 1, 0)).toEqual({ x: 2, y: 5, size: 10 });
        expect(checkboxRect(box, 0, 0)).toEqual({ x: 31, y: 5, size: 10 });
        expect(checkboxRect(box, 2, 2)).toEqual({ x: 60, y: 7, size: 10 });
    });

    test('only a click on the box counts', () => {
        const ctx = tickBoxContext([
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        expect(isCheckboxClick(ctx, 0, 0, box, 36, 9)).toBe(true);
        // Just outside the box on each axis, and out in the empty rest of the cell.
        expect(isCheckboxClick(ctx, 0, 0, box, 41, 9)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 36, 15)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(false);
    });

    test('every corner pixel of the box answers a click, and no pixel around it', () => {
        const ctx = tickBoxContext([
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        const rect = checkboxRect(box, 0, 0);
        const last = rect.size - 1;
        for (const [x, y] of [
            [rect.x, rect.y],
            [rect.x + last, rect.y],
            [rect.x, rect.y + last],
            [rect.x + last, rect.y + last],
        ]) {
            expect(isCheckboxClick(ctx, 0, 0, box, x, y)).toBe(true);
        }
        for (const [x, y] of [
            [rect.x, rect.y - 1],
            [rect.x - 1, rect.y],
            [rect.x + rect.size, rect.y + last],
            [rect.x + last, rect.y + rect.size],
        ]) {
            expect(isCheckboxClick(ctx, 0, 0, box, x, y)).toBe(false);
        }
    });

    test('ignores cells without a tick box rule', () => {
        const ctx = tickBoxContext([
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        expect(isCheckboxClick(ctx, 3, 3, box, 7, 9)).toBe(false);
    });
});

// The always-on list chevron. The painter and the mousedown hit-test share one
// geometry (dropdownChevronRect), the same split the tick box and the filter
// button use — these pin them together, threshold included.
const LIST_RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: 'Red,Green,Blue', value2: '' };

function listContext() {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].dataValidations = validationsByCell({
        '0_0': LIST_RULE,
        '1_0': TICK_BOX,
        '2_0': { type: 'number', type2: 'moreThanThe', value1: '3', value2: '' },
    });
    return ctx;
}

describe('dropdownChevronRect', () => {
    // Cell A1's text box is 72×18, so the 8px glyph lands at x 62..70, y 6..14.
    const box = cellTextBox(0, 0, 74, 20);

    test('right-aligns the glyph and centres it vertically, whatever the cell alignment', () => {
        expect(dropdownChevronRect(box)).toEqual({ x: 62, y: 6, size: 8 });
        expect(dropdownChevronRect({ left: 100, top: 40, width: 40, height: 30 })).toEqual({ x: 130, y: 51, size: 8 });
    });

    test('drops the glyph in a column too narrow to carry it', () => {
        // The threshold is the glyph, its padding, and as much again clear to its left.
        expect(dropdownChevronRect({ ...box, width: 18 })).toEqual({ x: 8, y: 6, size: 8 });
        expect(dropdownChevronRect({ ...box, width: 17 })).toBeUndefined();
        expect(dropdownChevronRect({ ...box, width: 0 })).toBeUndefined();
    });
});

describe('isDropdownChevronClick', () => {
    // Glyph at x 60..70 ⇒ the finger-sized hit box spans x 50..70, full height.
    const box = cellTextBox(0, 0, 74, 20);
    const RIGHT = 70;

    test('only a click on the chevron counts', () => {
        const ctx = listContext();
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, 9)).toBe(true);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - DROPDOWN_CHEVRON_HIT_WIDTH, box.top)).toBe(true);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT, box.top + box.height)).toBe(true);
        // One pixel outside each edge.
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - DROPDOWN_CHEVRON_HIT_WIDTH - 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT + 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, box.top - 1)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, box.top + box.height + 1)).toBe(false);
    });

    test('ignores every rule type that draws no chevron, and cells with no rule', () => {
        const ctx = listContext();
        expect(isDropdownChevronClick(ctx, 1, 0, box, RIGHT - 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 2, 0, box, RIGHT - 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 3, 3, box, RIGHT - 1, 9)).toBe(false);
    });

    test('a column too narrow to paint the chevron has nothing to click either', () => {
        const ctx = listContext();
        const narrow = { ...box, width: 21 };
        expect(isDropdownChevronClick(ctx, 0, 0, narrow, narrow.width, 9)).toBe(false);
    });
});

// validationValueProblem checks the dialog's rule before it is written. Every branch must refuse what it complains
// about: the dropdown and checkbox branches used to warn and fall through, so an empty rule was applied anyway and the
// range rendered as `☐ FALS`. An empty-valued rule is not a default TRUE/FALSE rule, so the painter drew the label too.
const draft = (rule: Partial<DataValidationDraft>): DataValidationDraft => ({
    type: 'dropdown',
    type2: '',
    rangeTxt: 'A1:A3',
    value1: '',
    value2: '',
    prohibitInput: false,
    hintShow: false,
    hintValue: '',
    ...rule,
});

describe('validationValueProblem', () => {
    test('refuses a drop-down rule with no options', () => {
        expect(validationValueProblem(draft({ type: 'dropdown', value1: '' }))).toBe(
            'The drop-down list option cannot be empty',
        );
    });

    test('refuses a checkbox rule with an empty selected or not-selected value', () => {
        expect(validationValueProblem(draft({ type: 'checkbox', value1: '', value2: '' }))).toBe(
            'Checkbox content cannot be empty',
        );
        expect(validationValueProblem(draft({ type: 'checkbox', value1: 'Yes', value2: '' }))).toBe(
            'Checkbox content cannot be empty',
        );
    });

    test('refuses a range that ends below its start', () => {
        expect(validationValueProblem(draft({ type: 'number', type2: 'between', value1: '5', value2: '1' }))).toBe(
            'The value 2 cannot be less than the value 1',
        );
    });

    test('accepts the rules it has no complaint about', () => {
        expect(validationValueProblem(draft({ type: 'dropdown', value1: 'Red,Green' }))).toBeUndefined();
        expect(validationValueProblem(draft({ type: 'checkbox', value1: 'TRUE', value2: 'FALSE' }))).toBeUndefined();
    });
});

// The in-grid validation card. It replaces a DOM singleton that cellFocus wrote
// with innerHTML on mousedown: the model is derived from the focus cell on every
// render instead, so it cannot strand over the wrong cell, an arrow-key user
// gets it, and rule text is content rather than markup.
function hintContext(rule: DataValidationRule, value?: Cell) {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].data = [
        [null, null, null, null],
        [null, value ?? null, null, null],
        [null, null, null, null],
        [null, null, null, null],
    ];
    ctx.sheets[0].dataValidations = validationsByCell({ '1_1': rule });
    return ctx;
}

describe('getValidationHint', () => {
    test('explains a rejected value in place of the old "Failure:" translationese', () => {
        const rule: DataValidationRule = { type: 'number', type2: 'between', value1: '1', value2: '10' };
        const hint = getValidationHint(hintContext(rule, { v: 42, m: '42' }), 1, 1);
        expect(hint).toEqual({
            kind: 'invalid',
            text: 'Input must be a number between 1 and 10.',
            position: { left: 74, top: 20, right: 148, bottom: 40 },
        });
    });

    test('says what a list cell wants, the way Google does', () => {
        const rule: DataValidationRule = { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' };
        expect(getValidationHint(hintContext(rule, { v: 'Purple', m: 'Purple' }), 1, 1)?.text).toBe(
            'Input must be an item on the specified list.',
        );
        expect(getValidationHint(hintContext({ ...rule, hintShow: true }), 1, 1)).toEqual({
            kind: 'prompt',
            text: 'Pick an item from the list.',
            position: { left: 74, top: 20, right: 148, bottom: 40 },
        });
    });

    test('a list rule reads what the cell shows, as its items are text', () => {
        const rule: DataValidationRule = { type: 'dropdown', type2: '', value1: '1,2', value2: '' };
        expect(getValidationHint(hintContext(rule, { v: 1, m: '1' }), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule, { v: 1 }), 1, 1)).toBeUndefined();
    });

    test('phrases each remaining rule type as a sentence', () => {
        const cases: [DataValidationRule, Cell, string][] = [
            [
                { type: 'text_content', type2: 'include', value1: 'ACME', value2: '' },
                { v: 'Globex', m: 'Globex' },
                'Text must include ACME.',
            ],
            [
                { type: 'text_content', type2: 'exclude', value1: 'ACME', value2: '' },
                { v: 'ACME Corp', m: 'ACME Corp' },
                'Text must not include ACME.',
            ],
            [
                { type: 'text_content', type2: 'equal', value1: 'ACME', value2: '' },
                { v: 'Globex', m: 'Globex' },
                'Text must be ACME.',
            ],
            [
                { type: 'text_length', type2: 'lessThan', value1: '3', value2: '' },
                { v: 'Globex', m: 'Globex' },
                'Text length must be less than 3.',
            ],
            [
                { type: 'date', type2: 'between', value1: '2024-01-01', value2: '2024-12-31' },
                { v: '2025-06-15', m: '2025-06-15' },
                'Date must be between 2024-01-01 and 2024-12-31.',
            ],
            [
                { type: 'number_integer', type2: 'moreThanThe', value1: '5', value2: '' },
                { v: 2, m: '2' },
                'Input must be a whole number greater than 5.',
            ],
        ];
        for (const [rule, cell, text] of cases) {
            expect(getValidationHint(hintContext(rule, cell), 1, 1)?.text).toBe(text);
        }
    });

    // 2024-06-15 is serial 45458. A date shows the text of its format, so the check reads the serial.
    test('a date passes its rule whatever format it shows', () => {
        const rule: DataValidationRule = { type: 'date', type2: 'between', value1: '2024-01-01', value2: '2024-12-31' };
        const shown = (m: string, v: number): Cell => ({ v, m, ct: { fa: 'd mmm yyyy', t: 'd' } });
        expect(getValidationHint(hintContext(rule, shown('15 Jun 2024', 45458)), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule, shown('2024-06-15', 45458)), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule, shown('15 Jun 2025', 45823)), 1, 1)?.text).toBe(
            'Date must be between 2024-01-01 and 2024-12-31.',
        );
    });

    test('a plain number under a date rule is read as a serial, and text that is no date fails', () => {
        const rule: DataValidationRule = { type: 'date', type2: 'laterThan', value1: '2024-01-01', value2: '' };
        expect(getValidationHint(hintContext(rule, { v: 45458, m: '45458' }), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule, { v: 'soon', m: 'soon' }), 1, 1)?.kind).toBe('invalid');
    });

    test('shows the author prompt verbatim, markup and all — React renders it as text', () => {
        const rule: DataValidationRule = {
            type: 'dropdown',
            type2: '',
            value1: 'Red',
            value2: '',
            hintShow: true,
            hintValue: '<img src=x onerror=alert(1)>',
        };
        expect(getValidationHint(hintContext(rule), 1, 1)).toEqual({
            kind: 'prompt',
            text: '<img src=x onerror=alert(1)>',
            position: { left: 74, top: 20, right: 148, bottom: 40 },
        });
    });

    test('a rejection outranks the prompt, and a valid value shows the prompt alone', () => {
        const rule: DataValidationRule = {
            type: 'number',
            type2: 'between',
            value1: '1',
            value2: '10',
            hintShow: true,
            hintValue: 'Score out of ten',
        };
        expect(getValidationHint(hintContext(rule, { v: 42, m: '42' }), 1, 1)?.kind).toBe('invalid');
        expect(getValidationHint(hintContext(rule, { v: 4, m: '4' }), 1, 1)?.text).toBe('Score out of ten');
    });

    test('stays silent where there is nothing to say', () => {
        const rule: DataValidationRule = { type: 'number', type2: 'between', value1: '1', value2: '10' };
        // A valid value, an empty cell, a cell with no rule, and a tick box holding one of its values.
        expect(getValidationHint(hintContext(rule, { v: 4, m: '4' }), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule), 0, 0)).toBeUndefined();
        const ticked = { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } };
        expect(getValidationHint(hintContext({ ...TICK_BOX, hintShow: true }, ticked), 1, 1)).toBeUndefined();
    });

    test('a tick box holding a value its rule does not name says which values it takes', () => {
        const hint = getValidationHint(hintContext(TICK_BOX, { v: 'nope', m: 'nope' }), 1, 1);
        expect(hint).toMatchObject({ kind: 'invalid', text: 'Input must be TRUE or FALSE.' });
    });
});
