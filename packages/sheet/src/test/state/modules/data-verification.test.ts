// Data-validation runtime paths the xlsx importer relies on. The dominant
// imported shape is a dropdown whose value1 is a live quoted cross-sheet
// $-anchored range ref ('MASTER DATA'!$B$2:$B$4) — getDropdownList must keep
// resolving it by sheet NAME. Date rules carry YYYY-MM-DD operand strings,
// the format validateCellData parses via isdatetime + dayjs.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { en } from '../../../state/locale/en';
import {
    applyDataVerification,
    cellTextBox,
    checkboxChange,
    checkboxRect,
    confirmMessage,
    DROPDOWN_CHEVRON_HIT_WIDTH,
    dropdownChevronRect,
    getDropdownList,
    getValidationHint,
    isCheckboxChecked,
    isCheckboxClick,
    isDropdownChevronClick,
    showsCheckboxLabel,
    validateCellData,
} from '../../../state/modules/data-verification';
import type { Cell, DataRegulationProps, DataVerificationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';

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
        const rule: DataVerificationRule = {
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
const TICK_BOX: DataVerificationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };

function tickBoxContext(data: Context['sheets'][number]['data']) {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].data = data;
    ctx.sheets[0].dataVerification = { '0_0': TICK_BOX, '1_0': TICK_BOX, '2_0': TICK_BOX };
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
        const rule: DataVerificationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
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
        const rule: DataVerificationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };
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

describe('applyDataVerification', () => {
    test('seeds only empty cells, keeping existing TRUE/FALSE values', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].data = [
            [{ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ];
        applyDataVerification(ctx, { row: [0, 2], column: [0, 0] }, TICK_BOX);

        expect(ctx.sheets[0].data[0][0]).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data[1][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(ctx.sheets[0].data[2][0]).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(Object.keys(ctx.sheets[0].dataVerification!)).toEqual(['0_0', '1_0', '2_0']);
    });

    test('never seeds cells for a non-checkbox rule', () => {
        const ctx = contextFactory() as Context;
        const rule: DataVerificationRule = { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' };
        applyDataVerification(ctx, { row: [0, 1], column: [0, 0] }, rule);
        expect(ctx.sheets[0].data![0][0]).toBeNull();
        expect(ctx.sheets[0].dataVerification!['0_0']).toEqual(rule);
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
    // A default left/middle rule puts the 10px box at x 2..12, y 5..15.
    const box = cellTextBox(0, 0, 74, 20);

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
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 9)).toBe(true);
        // Just outside the box on each axis, and out in the empty rest of the cell.
        expect(isCheckboxClick(ctx, 0, 0, box, 13, 9)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 7, 16)).toBe(false);
        expect(isCheckboxClick(ctx, 0, 0, box, 60, 9)).toBe(false);
    });

    test('every pixel of the painted box answers a click, its top row included', () => {
        const ctx = tickBoxContext([
            [{ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ]);
        const rect = checkboxRect(box, 1, 0);
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
const LIST_RULE: DataVerificationRule = { type: 'dropdown', type2: '', value1: 'Red,Green,Blue', value2: '' };

function listContext() {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].dataVerification = {
        '0_0': LIST_RULE,
        '1_0': TICK_BOX,
        '2_0': { type: 'number', type2: 'moreThanThe', value1: '3', value2: '' },
    };
    return ctx;
}

describe('dropdownChevronRect', () => {
    // Cell A1's text box is 72×18, so the 10px glyph lands at x 60..70, y 5..15.
    const box = cellTextBox(0, 0, 74, 20);

    test('right-aligns the glyph and centres it vertically, whatever the cell alignment', () => {
        expect(dropdownChevronRect(box)).toEqual({ x: 60, y: 5, size: 10 });
        expect(dropdownChevronRect({ left: 100, top: 40, width: 40, height: 30 })).toEqual({ x: 128, y: 50, size: 10 });
    });

    test('drops the glyph in a column too narrow to carry it', () => {
        expect(dropdownChevronRect({ ...box, width: 22 })).toEqual({ x: 10, y: 5, size: 10 });
        expect(dropdownChevronRect({ ...box, width: 21 })).toBeUndefined();
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

// confirmMessage validates the dialog's rule before it is written. Every branch
// must return false when it warns — the dropdown and checkbox branches used to
// set warnDialog and fall through, so an empty rule was applied anyway and the
// range rendered as `☐ FALS`: an empty-valued rule is not a default TRUE/FALSE
// rule, so the painter drew the label too.
function regulationContext(regulation: Partial<DataRegulationProps>) {
    const ctx = contextFactory() as Context;
    ctx.dataVerification = {
        selectStatus: false,
        selectRange: [],
        dataRegulation: {
            type: 'dropdown',
            type2: '',
            rangeTxt: 'A1:A3',
            value1: '',
            value2: '',
            validity: '',
            remote: false,
            prohibitInput: false,
            hintShow: false,
            hintValue: '',
            ...regulation,
        },
    };
    return ctx;
}

function confirm(ctx: Context) {
    return confirmMessage(ctx, en.generalDialog, en.dataVerification);
}

describe('confirmMessage', () => {
    test('rejects a drop-down rule with no options', () => {
        const ctx = regulationContext({ type: 'dropdown', value1: '' });
        expect(confirm(ctx)).toBe(false);
        expect(ctx.warnDialog).toBe(en.dataVerification.tooltipInfo1);
    });

    test('rejects a checkbox rule with an empty selected or not-selected value', () => {
        const empty = regulationContext({ type: 'checkbox', value1: '', value2: '' });
        expect(confirm(empty)).toBe(false);
        expect(empty.warnDialog).toBe(en.dataVerification.tooltipInfo2);

        const halfEmpty = regulationContext({ type: 'checkbox', value1: 'Yes', value2: '' });
        expect(confirm(halfEmpty)).toBe(false);
    });

    test('accepts the rules it has no complaint about', () => {
        expect(confirm(regulationContext({ type: 'dropdown', value1: 'Red,Green' }))).toBe(true);
        expect(confirm(regulationContext({ type: 'checkbox', value1: 'TRUE', value2: 'FALSE' }))).toBe(true);
    });
});

// The in-grid validation card. It replaces a DOM singleton that cellFocus wrote
// with innerHTML on mousedown: the model is derived from the focus cell on every
// render instead, so it cannot strand over the wrong cell, an arrow-key user
// gets it, and rule text is content rather than markup.
function hintContext(rule: DataVerificationRule, value?: Cell) {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].data = [
        [null, null, null, null],
        [null, value ?? null, null, null],
        [null, null, null, null],
        [null, null, null, null],
    ];
    ctx.sheets[0].dataVerification = { '1_1': rule };
    return ctx;
}

describe('getValidationHint', () => {
    test('explains a rejected value in place of the old "Failure:" translationese', () => {
        const rule: DataVerificationRule = { type: 'number', type2: 'between', value1: '1', value2: '10' };
        const hint = getValidationHint(hintContext(rule, { v: 42, m: '42' }), 1, 1);
        expect(hint).toEqual({
            kind: 'invalid',
            text: 'Input must be a number between 1 and 10.',
            left: 74,
            top: 40,
        });
    });

    test('says what a list cell wants, the way Google does', () => {
        const rule: DataVerificationRule = { type: 'dropdown', type2: '', value1: 'Red,Green', value2: '' };
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
        const cases: [DataVerificationRule, Cell, string][] = [
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

    test('shows the author prompt verbatim, markup and all — React renders it as text', () => {
        const rule: DataVerificationRule = {
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
        const rule: DataVerificationRule = {
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
        const rule: DataVerificationRule = { type: 'number', type2: 'between', value1: '1', value2: '10' };
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
