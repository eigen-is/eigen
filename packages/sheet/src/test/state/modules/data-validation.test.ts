// Data-validation runtime paths the xlsx importer relies on. The dominant
// imported shape is a dropdown whose value1 is a live quoted cross-sheet
// $-anchored range ref ('MASTER DATA'!$B$2:$B$4) — getDropdownList must keep
// resolving it by sheet NAME. Date rules carry YYYY-MM-DD operand strings,
// the format validateCellData parses via isdatetime + dayjs.

import { describe, expect, test } from 'bun:test';
import {
    MAX_VALIDATION_RANGES,
    MAX_VALIDATIONS,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
} from '@workspace/lib/sheets';
import type { Context } from '../../../state/context';
import {
    applyDataValidation,
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
    showsCheckboxLabel,
    validateCellData,
    validationRange,
    validationValueProblem,
} from '../../../state/modules/data-validation';
import {
    addValidation,
    clearValidations,
    ValidationLimitError,
    validationAt,
    validationLookup,
} from '../../../state/modules/validation-rules';
import type { Cell, DataValidationDraft, DataValidationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';
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
    test('parses the importer date operand format (YYYY-MM-DD)', () => {
        const ctx = contextFactory() as Context;
        const rule: DataValidationRule = {
            type: 'date',
            type2: 'between',
            value1: '2024-01-01',
            value2: '2024-12-31',
        };
        expect(validateCellData(ctx, rule, '2024-06-15')).toBe(true);
        expect(validateCellData(ctx, rule, '2025-06-15')).toBe(false);
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

describe('showsCheckboxLabel', () => {
    test('a default rule draws the box alone over the values it names', () => {
        expect(showsCheckboxLabel(TICK_BOX, 'TRUE')).toBe(false);
        expect(showsCheckboxLabel(TICK_BOX, 'false')).toBe(false);
        expect(showsCheckboxLabel(TICK_BOX, true)).toBe(false);
        expect(showsCheckboxLabel(TICK_BOX, false)).toBe(false);
    });

    test('an empty cell in the range keeps the plain box, so the column reads as one', () => {
        expect(showsCheckboxLabel(TICK_BOX, null)).toBe(false);
        expect(showsCheckboxLabel(TICK_BOX, undefined)).toBe(false);
        expect(showsCheckboxLabel(TICK_BOX, '')).toBe(false);
    });

    test('a value the rule does not name keeps its label', () => {
        // Insert -> Tick box over a column of Yes / Maybe / n/a used to paint an
        // unchecked box over every one of them with the text suppressed: the data
        // was still there, unreadable, and validateCellData flags nothing either.
        expect(showsCheckboxLabel(TICK_BOX, 'Yes')).toBe(true);
        expect(showsCheckboxLabel(TICK_BOX, 'Maybe')).toBe(true);
        expect(showsCheckboxLabel(TICK_BOX, 'n/a')).toBe(true);
        expect(showsCheckboxLabel(TICK_BOX, 0)).toBe(true);
    });

    test('a custom rule always keeps its label — it is the only way to tell Yes from No', () => {
        const rule: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
        expect(showsCheckboxLabel(rule, 'Yes')).toBe(true);
        expect(showsCheckboxLabel(rule, 'No')).toBe(true);
        expect(showsCheckboxLabel(rule, 'Maybe')).toBe(true);
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
// Every peer, the server and a reload drop a rule past the caps, so a writer refuses an edit that would make one.
describe('a write past the caps', () => {
    const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };

    test('a clear that would split a rule past the ranges a rule may hold throws', () => {
        const ctx = contextFactory() as Context;
        const [sheet] = ctx.sheets;
        const rows = Array.from({ length: MAX_VALIDATION_RANGES }, (_, i) => ({ row: [2 * i, 2 * i], column: [0, 2] }));
        sheet.dataValidations = { v: { ranges: rows, rule } };
        expect(() => clearValidations(sheet, { row: [0, 0], column: [1, 1] })).toThrow(ValidationLimitError);
        clearValidations(sheet, { row: [0, 0], column: [0, 0] });
        expect(sheet.dataValidations.v.ranges).toHaveLength(MAX_VALIDATION_RANGES);
    });

    test('a new rule on a sheet that holds as many rules as a sheet may throws, and a grown one does not', () => {
        const ctx = contextFactory() as Context;
        const [sheet] = ctx.sheets;
        sheet.dataValidations = Object.fromEntries(
            Array.from({ length: MAX_VALIDATIONS }, (_, i) => [
                `v${i}`,
                { ranges: [{ row: [i, i], column: [0, 0] }], rule },
            ]),
        );
        const range = { row: [0, 0], column: [5, 5] };
        expect(() => addValidation(sheet, 'new', rule, [range])).toThrow(ValidationLimitError);
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

// Cell A1 spans x 0..74, y 0..20 (contextFactory's visibledata*). The painter
// and the hit test used to build its text box three different ways, so the box
// was drawn one pixel below the box that answered a click.
describe('cellTextBox', () => {
    test('insets the cell by the grid lines it must not paint over', () => {
        expect(cellTextBox(0, 0, 74, 20)).toEqual({ left: 0, top: 1, width: 72, height: 18 });
    });

    test('painter and hit test describe the same box for the same cell', () => {
        // The painter works in canvas space (the row/column headers already added
        // in), the mousedown hit test in freeze-corrected sheet space. Take the
        // offset back out and the two must be the same box, to the pixel.
        const offsetLeft = 60;
        const offsetTop = 20;
        const painted = cellTextBox(0 + offsetLeft, 0 + offsetTop, 74 + offsetLeft, 20 + offsetTop);
        const clickable = cellTextBox(0, 0, 74, 20);

        expect(painted.left - offsetLeft).toBe(clickable.left);
        expect(painted.top - offsetTop).toBe(clickable.top);
        expect(painted.width).toBe(clickable.width);
        expect(painted.height).toBe(clickable.height);
    });
});

describe('isCheckboxClick', () => {
    // A cell without its own alignment centres the 10px box, at x 31..41, y 5..15.
    const box = cellTextBox(0, 0, 74, 20);

    // As Google centres it: ticked, unticked and empty boxes sit in one place. A box with a label beside it sits left,
    // so the label keeps the cell's width; the cell's own alignment places either.
    const YES_NO: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
    const ticked = { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } };
    test('a tick box drawn alone is centred, one with a label left, unless its cell is aligned', () => {
        const alone = [
            [ticked, 'TRUE'],
            [{ ...ticked, v: false, m: 'FALSE' }, 'FALSE'],
            [null, null],
            [{}, ''],
        ] as const;
        expect(alone.map(([cell, value]) => checkboxAlign(cell, TICK_BOX, value))).toEqual([0, 0, 0, 0]);
        expect(checkboxAlign({ v: 'Done', m: 'Done' }, TICK_BOX, 'Done')).toBe(1);
        // A rule with its own values labels every box, so an empty one stays in its column.
        expect(checkboxAlign({ v: 'Yes', m: 'Yes' }, YES_NO, 'Yes')).toBe(1);
        expect(checkboxAlign(null, YES_NO, null)).toBe(1);
        expect([1, 2, 0].map((ht) => checkboxAlign({ ...ticked, ht }, TICK_BOX, 'TRUE'))).toEqual([1, 2, 0]);
        expect([1, 2, 0].map((ht) => checkboxAlign({ v: 'Yes', m: 'Yes', ht }, YES_NO, 'Yes'))).toEqual([1, 2, 0]);
    });

    test('a click finds a labelled box at the left, where the painter draws it', () => {
        const ctx = tickBoxContext([
            [{ v: 'Yes', m: 'Yes' }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': YES_NO });
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(true);
        expect(isCheckboxClick(ctx, 0, 0, box, 36, 9)).toBe(false);
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
        expect(isCheckboxClick(ctx, 0, 0, box, 42, 9)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 36, 16)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(false);
    });

    test('every pixel of the painted box answers a click, its top row included', () => {
        const ctx = tickBoxContext([
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        const rect = checkboxRect(box, 0, 0);
        for (const [x, y] of [
            [rect.x, rect.y],
            [rect.x + rect.size, rect.y],
            [rect.x, rect.y + rect.size],
            [rect.x + rect.size, rect.y + rect.size],
        ]) {
            expect(isCheckboxClick(ctx, 0, 0, box, x, y)).toBe(true);
        }
        // The row above the box is the cell, not the box.
        expect(isCheckboxClick(ctx, 0, 0, box, rect.x, rect.y - 1)).toBe(false);
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
            left: 74,
            top: 40,
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
            left: 74,
            top: 40,
        });
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
            left: 74,
            top: 40,
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
        // Valid value, empty cell, a cell with no rule, and a tick box — which
        // can never be invalid and needs no prompt.
        expect(getValidationHint(hintContext(rule, { v: 4, m: '4' }), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule), 1, 1)).toBeUndefined();
        expect(getValidationHint(hintContext(rule), 0, 0)).toBeUndefined();
        expect(
            getValidationHint(hintContext({ ...TICK_BOX, hintShow: true }, { v: 'nope', m: 'nope' }), 1, 1),
        ).toBeUndefined();
    });
});
