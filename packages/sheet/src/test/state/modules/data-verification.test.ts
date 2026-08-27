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
    checkboxChange,
    checkboxRect,
    confirmMessage,
    DROPDOWN_CHEVRON_HIT_WIDTH,
    dropdownChevronRect,
    getDropdownList,
    isCheckboxChecked,
    isCheckboxClick,
    isDefaultCheckboxRule,
    isDropdownChevronClick,
    validateCellData,
} from '../../../state/modules/data-verification';
import type { DataRegulationProps, DataVerificationRule } from '../../../state/types';
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
        expect(isDefaultCheckboxRule(rule)).toBe(false);
        expect(isDefaultCheckboxRule(TICK_BOX)).toBe(true);
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

describe('isCheckboxClick', () => {
    // Cell A1 spans x 0..74, y 0..20 (contextFactory's visibledata*), so a
    // default left/middle rule puts the 10px box at x 2..12, y 4..14.
    const box = { left: 0, top: 0, width: 72, height: 18 };

    test('places the box by the cell alignment', () => {
        expect(checkboxRect(box, 1, 0)).toEqual({ x: 2, y: 4, size: 10 });
        expect(checkboxRect(box, 0, 0)).toEqual({ x: 31, y: 4, size: 10 });
        expect(checkboxRect(box, 2, 2)).toEqual({ x: 60, y: 6, size: 10 });
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
    // Cell A1 spans x 0..74, y 0..20 (contextFactory's visibledata*), so its
    // text box is 72×18 and the 10px glyph lands at x 60..70, y 4..14.
    const box = { left: 0, top: 0, width: 72, height: 18 };

    test('right-aligns the glyph and centres it vertically, whatever the cell alignment', () => {
        expect(dropdownChevronRect(box)).toEqual({ x: 60, y: 4, size: 10 });
        expect(dropdownChevronRect({ left: 100, top: 40, width: 40, height: 30 })).toEqual({ x: 128, y: 50, size: 10 });
    });

    test('drops the glyph in a column too narrow to carry it', () => {
        expect(dropdownChevronRect({ ...box, width: 22 })).toEqual({ x: 10, y: 4, size: 10 });
        expect(dropdownChevronRect({ ...box, width: 21 })).toBeUndefined();
        expect(dropdownChevronRect({ ...box, width: 0 })).toBeUndefined();
    });
});

describe('isDropdownChevronClick', () => {
    // Glyph at x 60..70 ⇒ the finger-sized hit box spans x 50..70, full height.
    const box = { left: 0, top: 0, width: 72, height: 18 };
    const RIGHT = 70;

    test('only a click on the chevron counts', () => {
        const ctx = listContext();
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, 9)).toBe(true);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - DROPDOWN_CHEVRON_HIT_WIDTH, 0)).toBe(true);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT, box.height)).toBe(true);
        // One pixel outside each edge.
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - DROPDOWN_CHEVRON_HIT_WIDTH - 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT + 1, 9)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, -1)).toBe(false);
        expect(isDropdownChevronClick(ctx, 0, 0, box, RIGHT - 1, box.height + 1)).toBe(false);
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
        optionLabel: en.dataVerification.optionLabel,
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
