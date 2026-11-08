// What a data-validation rule does on the grid, such as a drop-down list, a tick box or a number condition. This
// module checks a value against its rule, lays out and toggles tick boxes and list chevrons for the painter and the hit
// test, writes the hint a selected cell shows, and validates and applies the draft the data-validation dialog edits.
// Which rule covers a cell is the rule store's to say (validationAt).

import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { cloneDeep } from 'es-toolkit/compat';
import { booleanDisplay, cellDisplay, cellValue } from '../../engine/format';
import { iscelldata, matrixWidth } from '../../engine/formula-utils';
import { dateToSerial } from '../../engine/parser/helper/number';
import type { Cell } from '../../engine/types';
import type { CellMatrix, Context, DataValidationRule, SingleRange } from '..';
import {
    diff,
    getCellValue,
    getcellrange,
    getFlowdata,
    getRangeByTxt,
    getRealCellValue,
    getSheetIndex,
    isdatetime,
    isRealNull,
    isRealNum,
    jfrefreshgrid,
    mergeBorder,
    normalizedAttr,
    normalizedCellAttr,
    setCellValue,
} from '..';
import { getSheet } from '../api/common';
import type { DataValidationDraft, Rect } from '../types';
import { clipToUsedExtent, replaceHtml } from '../utils';
import { addValidation, validationAt } from './validation-rules';

// The words a hint sentence puts in for its rule type and its condition. The keys are loose strings because a rule's
// type and condition are free-form. Text rules have sentences of their own, because "Text must equal to ACME" reads
// wrong.
const OPTION_LABEL: Record<string, string> = {
    number: 'a number',
    number_integer: 'a whole number',
    number_decimal: 'a decimal number',
    between: 'between',
    notBetween: 'not between',
    equal: 'equal to',
    notEqualTo: 'not equal to',
    moreThanThe: 'greater than',
    lessThan: 'less than',
    greaterOrEqualTo: 'greater than or equal to',
    lessThanOrEqualTo: 'less than or equal to',
    earlierThan: 'earlier than',
    noEarlierThan: 'not earlier than',
    laterThan: 'later than',
    noLaterThan: 'not later than',
};

// A value checked against a rule, as a cell holds or shows it.
type CellValueForValidation = string | number | boolean | null | undefined;

export function getDropdownList(ctx: Context, txt: string) {
    const list = new Set<string | number | boolean>();
    if (iscelldata(txt)) {
        const range = getcellrange(ctx, txt);
        const data = getSheet(ctx, { id: range?.sheetId }).data;
        if (!data || !range) return [];
        for (let r = range.row[0]; r <= range.row[1]; r += 1) {
            for (let c = range.column[0]; c <= range.column[1]; c += 1) {
                const cell = data[r]?.[c];
                const value = cellValue(cell);
                if (cell && value) list.add(cellDisplay(cell) || value);
            }
        }
    } else {
        for (const item of txt.split(',')) {
            if (item.length > 0) list.add(item);
        }
    }
    return [...list];
}

export function validateCellData(ctx: Context, item: DataValidationRule, value: CellValueForValidation) {
    const { type, type2, value1, value2 } = item;
    if (type === 'dropdown') {
        const list = new Set(getDropdownList(ctx, value1).map(String));

        // A rule that allows several values stores them comma-separated, and each one must be on the list.
        if (type2 && value != null && value !== '') {
            return String(value)
                .split(',')
                .every((i) => list.has(i));
        }

        return value != null && list.has(String(value));
    }
    if (type === 'checkbox') {
        return true;
    }
    if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        if (!isRealNum(value)) return false;
        const n = Number(value);
        if (type === 'number_integer' && n % 1 !== 0) return false;
        if (type === 'number_decimal' && n % 1 === 0) return false;
        return meetsCondition(n, type2, Number(value1), Number(value2));
    }
    if (type === 'text_content') {
        const s = String(value ?? '');
        if (type2 === 'include') return s.includes(value1);
        if (type2 === 'exclude') return !s.includes(value1);
        return type2 !== 'equal' || s === value1;
    }
    if (type === 'text_length') {
        return meetsCondition(String(value ?? '').length, type2, Number(value1), Number(value2));
    }
    if (type === 'date') {
        return typeof value === 'number' && meetsCondition(value, type2, operandSerial(value1), operandSerial(value2));
    }
    return true;
}

// A cell against its rule. A list holds the text its source cells show, so a list rule reads what the cell shows.
// Any other rule reads the value, which a number format doesn't change.
export function cellPassesRule(ctx: Context, rule: DataValidationRule, cell: Cell | null | undefined) {
    return validateCellData(ctx, rule, rule.type === 'dropdown' ? cellDisplay(cell) : cellValue(cell));
}

// A commit from the cell editor against the cell's rule. The text the editor opened with changes nothing, even where
// no write could read it back, such as a date shown as dd/MM/yyyy. Other text is read as the write will read it.
export function inputPassesRule(ctx: Context, rule: DataValidationRule, cell: Cell | null | undefined, text = '') {
    if (text === cell?.f || text === String(cellDisplay(cell) ?? '')) return true;
    const typed: CellMatrix = [[cloneDeep(cell ?? null)]];
    setCellValue(ctx, 0, 0, typed, text);
    return cellPassesRule(ctx, rule, typed[0][0]);
}

// A rule's date operand is YYYY-MM-DD text, read in local time as a typed date is. It can fall before 1900, where
// isdatetime stops: Excel's "any date" stores serial 1, which the importer writes as 1899-12-31.
function operandSerial(operand: string) {
    return dateToSerial(new Date(operand.replace(/-/g, '/')));
}

// The number and date rules name the same comparisons in their own words.
function meetsCondition(n: number, condition: string, v1: number, v2: number) {
    switch (condition) {
        case 'between':
            return n >= v1 && n <= v2;
        case 'notBetween':
            return n < v1 || n > v2;
        case 'equal':
            return n === v1;
        case 'notEqualTo':
            return n !== v1;
        case 'moreThanThe':
        case 'laterThan':
            return n > v1;
        case 'lessThan':
        case 'earlierThan':
            return n < v1;
        case 'greaterOrEqualTo':
        case 'noEarlierThan':
            return n >= v1;
        case 'lessThanOrEqualTo':
        case 'noLaterThan':
            return n <= v1;
        default:
            return true;
    }
}

// A tick box rule names the value that counts as checked, and the cell's value says whether it is. No second flag is
// stored, so a TRUE that was imported, pasted, typed or computed by a formula shows ticked like any other. These are
// the engine's own boolean texts, the ones a recalculated formula writes, so a computed TRUE matches.
export const CHECKBOX_CHECKED_VALUE = booleanDisplay(true);
export const CHECKBOX_UNCHECKED_VALUE = booleanDisplay(false);

// The tick box's side in px. The painter and the hit test both place it through checkboxRect, so they agree.
export const CHECKBOX_SIZE = 10;
// The gap between the box and the label beside it.
export const CHECKBOX_LABEL_GAP = 4;
// The same padding the painter keeps inside a cell.
const CHECKBOX_PADDING = 2;

// A square glyph inside a cell's text box, such as the tick box or the list chevron. The painter works in canvas
// pixels and the hit test in sheet pixels, and the glyph sits at the same offset from the box in both.
export type CellGlyphRect = { x: number; y: number; size: number };

// The box a cell lays its text out in, from the cell's bounds. It leaves out the grid lines: one pixel at the top, and
// two off the width and the height. The painter and the hit test both use it, so a click lands where the glyph is
// painted, in the top row too.
export function cellTextBox(left: number, top: number, right: number, bottom: number): Rect {
    return { left, top: top + 1, width: right - left - 2, height: bottom - top - 2 };
}

// Whether a tick-box cell shows its value beside the box. A default TRUE/FALSE rule shows the box alone, as Google
// Sheets does, and so does an empty cell, so the column looks the same all the way down. A custom rule keeps its label,
// because the label is the only way to tell "Yes" from "No". A value the rule does not name keeps it too, so a tick box
// put over a column of text does not hide the text.
export function showsCheckboxLabel(item: DataValidationRule, cellValue: CellValueForValidation) {
    if (item.value1 !== CHECKBOX_CHECKED_VALUE || item.value2 !== CHECKBOX_UNCHECKED_VALUE) return true;
    if (isRealNull(cellValue)) return false;
    const value = String(cellValue).toUpperCase();
    return value !== item.value1.toUpperCase() && value !== item.value2.toUpperCase();
}

export function isCheckboxChecked(item: DataValidationRule, cellValue: CellValueForValidation) {
    if (isRealNull(cellValue)) return false;
    return String(cellValue).toUpperCase() === item.value1.toUpperCase();
}

// A tick box sits where the cell's own alignment puts it. Without one, a box shown alone is centered, as in Google
// Sheets, so ticked, unticked and empty boxes line up. A box with a label sits left, so the label keeps the cell's
// width.
export function checkboxAlign(
    cell: Cell | null | undefined,
    rule: DataValidationRule,
    value: CellValueForValidation,
): number {
    if (cell?.ht != null) return Number(normalizedCellAttr(cell, 'ht'));
    return showsCheckboxLabel(rule, value) ? 1 : 0;
}

// The alignments use the cell's codes. For horizonAlign 0 is center, 1 is left and 2 is right. For verticalAlign 0 is
// middle, 1 is top and 2 is bottom. An empty cell's vertical alignment is NaN, which falls to the middle, as in the
// painter.
export function checkboxRect(box: Rect, horizonAlign: number, verticalAlign: number): CellGlyphRect {
    let x = box.left + CHECKBOX_PADDING;
    if (horizonAlign === 0) {
        x = box.left + (box.width - CHECKBOX_SIZE) / 2;
    } else if (horizonAlign === 2) {
        x = box.left + box.width - CHECKBOX_PADDING - CHECKBOX_SIZE;
    }

    let y = box.top + (box.height - CHECKBOX_SIZE) / 2;
    if (verticalAlign === 1) {
        y = box.top + CHECKBOX_PADDING;
    } else if (verticalAlign === 2) {
        y = box.top + box.height - CHECKBOX_PADDING - CHECKBOX_SIZE;
    }

    return { x, y, size: CHECKBOX_SIZE };
}

// The rule that governs one cell on the current sheet, as getCellHyperlink finds a cell's link.
export function getCellDataValidation(ctx: Context, r: number, c: number) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return undefined;
    return validationAt(ctx.sheets[index].dataValidations, r, c);
}

// Only a click on the box toggles it. A click anywhere else in the cell just selects the cell, so a tick box can be
// copied, filled and read in the formula bar without flipping.
export function isCheckboxClick(ctx: Context, r: number, c: number, box: Rect, x: number, y: number) {
    const rule = getCellDataValidation(ctx, r, c);
    if (rule?.type !== 'checkbox') return false;
    const d = getFlowdata(ctx);
    if (!d) return false;
    const align = checkboxAlign(d[r]?.[c], rule, getRealCellValue(r, c, d));
    const rect = checkboxRect(box, align, Number(normalizedAttr(d, r, c, 'vt')));
    return x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size;
}

// Returns whether the cell toggled. When it did not, the mouse and keyboard callers go on with their normal handling.
export function checkboxChange(ctx: Context, r: number, c: number) {
    if (ctx.allowEdit === false) return false;
    const item = getCellDataValidation(ctx, r, c);
    if (item?.type !== 'checkbox') return false;
    const d = getFlowdata(ctx);
    if (!d) return false;
    // A tick box computed by a formula can't be clicked, because writing a value would replace the formula.
    if (d[r]?.[c]?.f != null) return false;
    const checked = isCheckboxChecked(item, getRealCellValue(r, c, d));
    setCellValue(ctx, r, c, d, checked ? item.value2 : item.value1);
    // The write must recalculate the formulas that depend on this cell. The mousedown has not moved the selection here
    // yet, so the toggled cell is named.
    jfrefreshgrid(ctx, [{ row: [r, r], column: [c, c] }]);
    return true;
}

// A list rule paints its chevron on every cell it covers, selected or not, as the comment triangle and the filter
// button are painted. Keyboard users and viewers who can't edit then see the list too. These are the glyph's side in
// pixels and its gap from the cell's right edge.
export const DROPDOWN_CHEVRON_SIZE = 8;
const DROPDOWN_CHEVRON_PADDING = 2;
// The click target around the glyph is wide enough for a finger, as the filter button's is.
export const DROPDOWN_CHEVRON_HIT_WIDTH = 20;
// The narrowest text box that still gets a chevron: the glyph, its padding, and as much again clear to its left. In a
// narrower cell the glyph would look like the cell's content, so it is left out, as Google Sheets does.
const DROPDOWN_CHEVRON_MIN_WIDTH = DROPDOWN_CHEVRON_SIZE * 2 + DROPDOWN_CHEVRON_PADDING;

// Where the chevron sits, for the painter and the mousedown hit test alike. It is right-aligned and centered vertically
// whatever the cell's alignment, because it marks the cell and is not part of its content.
export function dropdownChevronRect(box: Rect): CellGlyphRect | undefined {
    if (box.width < DROPDOWN_CHEVRON_MIN_WIDTH) return undefined;
    return {
        x: box.left + box.width - DROPDOWN_CHEVRON_PADDING - DROPDOWN_CHEVRON_SIZE,
        y: box.top + (box.height - DROPDOWN_CHEVRON_SIZE) / 2,
        size: DROPDOWN_CHEVRON_SIZE,
    };
}

// A click on the chevron opens the list, as a click on the filter button opens its menu. A click anywhere else in the
// cell just selects it.
export function isDropdownChevronClick(ctx: Context, r: number, c: number, box: Rect, x: number, y: number) {
    if (getCellDataValidation(ctx, r, c)?.type !== 'dropdown') return false;
    const rect = dropdownChevronRect(box);
    if (!rect) return false;
    const right = rect.x + rect.size;
    return x >= right - DROPDOWN_CHEVRON_HIT_WIDTH && x <= right && y >= box.top && y <= box.top + box.height;
}

// Puts one rule on a range, in place of the rules its cells had. Tick boxes seed their unchecked value into EMPTY
// cells only: pointing a tick box at a column of existing TRUE/FALSE must keep the data, and isCheckboxChecked reads
// whatever was already there. The seeding stops where the sheet's cells stop, so a whole-column tick box writes no
// million cells.
export function applyDataValidation(ctx: Context, range: SingleRange, item: DataValidationRule) {
    if (ctx.allowEdit === false) return;
    const d = getFlowdata(ctx);
    if (!d) return;
    addValidation(getSheet(ctx), crypto.randomUUID(), { ...item }, [range]);
    if (item.type !== 'checkbox') return;
    const seededRange = {
        row: [range.row[0], Math.min(range.row[1], d.length - 1)],
        column: [range.column[0], Math.min(range.column[1], matrixWidth(d) - 1)],
    };
    let seeded = false;
    for (let r = seededRange.row[0]; r <= seededRange.row[1]; r += 1) {
        for (let c = seededRange.column[0]; c <= seededRange.column[1]; c += 1) {
            if (!isRealNull(getRealCellValue(r, c, d))) continue;
            setCellValue(ctx, r, c, d, item.value2);
            seeded = true;
        }
    }
    if (seeded) jfrefreshgrid(ctx, [seededRange]);
}

// The range the dialog's text names. A whole column such as B:B runs to the grid's last row, as Excel stores it, so
// the rule also covers the rows added later. A whole row runs to the grid's last column. The formula reader would
// stop both where the sheet's cells stop.
export function validationRange(ctx: Context, txt: string): SingleRange | undefined {
    const range = getRangeByTxt(ctx, txt).at(-1);
    if (!range) return undefined;
    const ref = txt.slice(txt.lastIndexOf('!') + 1);
    if (/^\$?[A-Za-z]+:\$?[A-Za-z]+$/.test(ref))
        return { row: [range.row[0], REFERENCE_ROW_COUNT - 1], column: range.column };
    if (/^\$?\d+:\$?\d+$/.test(ref)) return { row: range.row, column: [range.column[0], REFERENCE_COLUMN_COUNT - 1] };
    return { row: range.row, column: range.column };
}

// Insert > Tick box adds a tick box in one click, with no dialog, as in Google Sheets. With no dialog there is no
// chance to check the range. So a whole column or row selected from its header stops where the sheet's cells stop,
// because a tick box past them marks nothing. A range the user dragged out can still lay a checklist over empty cells.
export function insertCheckbox(ctx: Context) {
    const selection = ctx.selections?.[ctx.selections.length - 1];
    if (!selection) return;
    applyDataValidation(ctx, clipToUsedExtent(ctx, [selection])[0], {
        type: 'checkbox',
        type2: '',
        value1: CHECKBOX_CHECKED_VALUE,
        value2: CHECKBOX_UNCHECKED_VALUE,
    });
}

// The card a validated cell shows: why its value was rejected, or what to type.
export type ValidationHint = {
    kind: 'invalid' | 'prompt';
    text: string;
    // The card hangs under the cell, a merged cell included. This is the cell's bottom-left corner in content pixels.
    left: number;
    top: number;
};

// "between 1 and 10", "greater than 5", "earlier than 2024-01-01".
function conditionPhrase(item: DataValidationRule) {
    const { type2, value1, value2 } = item;
    const label = OPTION_LABEL[type2];
    if (!label) return '';
    if (type2 === 'between' || type2 === 'notBetween') return `${label} ${value1} and ${value2}`;
    return `${label} ${value1}`;
}

// Each rule type has two sentences: why the value in the cell was rejected, and what to type instead.
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: replaceHtml fills these ${name} slots, not JavaScript
const HINT_FRAMES = {
    listInvalid: 'Input must be an item on the specified list.',
    listPrompt: 'Pick an item from the list.',
    numberInvalid: 'Input must be ${type} ${condition}.',
    numberPrompt: 'Enter ${type} ${condition}.',
    textIncludeInvalid: 'Text must include ${value}.',
    textIncludePrompt: 'Enter text that includes ${value}.',
    textExcludeInvalid: 'Text must not include ${value}.',
    textExcludePrompt: 'Enter text that does not include ${value}.',
    textEqualInvalid: 'Text must be ${value}.',
    textEqualPrompt: 'Enter ${value}.',
    lengthInvalid: 'Text length must be ${condition}.',
    lengthPrompt: 'Enter text of length ${condition}.',
    dateInvalid: 'Date must be ${condition}.',
    datePrompt: 'Enter a date ${condition}.',
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: replaceHtml fills these ${name} slots, not JavaScript

// The warning shown when a rule refuses a typed value uses this text too, so both ways of reporting a rejected value
// say the same thing.
export function describeValidationRule(item: DataValidationRule, kind: ValidationHint['kind']) {
    const invalid = kind === 'invalid';
    const { type, type2 } = item;

    let frame = '';
    if (type === 'dropdown') {
        frame = invalid ? HINT_FRAMES.listInvalid : HINT_FRAMES.listPrompt;
    } else if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        frame = invalid ? HINT_FRAMES.numberInvalid : HINT_FRAMES.numberPrompt;
    } else if (type === 'text_content') {
        if (type2 === 'include') frame = invalid ? HINT_FRAMES.textIncludeInvalid : HINT_FRAMES.textIncludePrompt;
        else if (type2 === 'exclude') frame = invalid ? HINT_FRAMES.textExcludeInvalid : HINT_FRAMES.textExcludePrompt;
        else if (type2 === 'equal') frame = invalid ? HINT_FRAMES.textEqualInvalid : HINT_FRAMES.textEqualPrompt;
    } else if (type === 'text_length') {
        frame = invalid ? HINT_FRAMES.lengthInvalid : HINT_FRAMES.lengthPrompt;
    } else if (type === 'date') {
        frame = invalid ? HINT_FRAMES.dateInvalid : HINT_FRAMES.datePrompt;
    }
    // A tick box can't hold an invalid value and needs no prompt, so it shows no card.
    if (!frame) return '';

    // A rule's value comes from a collaborator or an imported file, and String.replace would read a `$&` or `$1` in it
    // as a pattern. replaceHtml puts the value in as plain text.
    return replaceHtml(frame, {
        type: OPTION_LABEL[type] ?? '',
        condition: conditionPhrase(item),
        value: item.value1,
    });
}

// The cell's rectangle in content pixels, the whole of a merged cell included. The card hangs off its bottom-left
// corner, and the hidden list anchor sits in it.
function cellRectAt(ctx: Context, d: CellMatrix, r: number, c: number) {
    const rect = {
        top: r === 0 ? 0 : ctx.visibledatarow[r - 1],
        bottom: ctx.visibledatarow[r],
        left: c === 0 ? 0 : ctx.visibledatacolumn[c - 1],
        right: ctx.visibledatacolumn[c],
    };
    const merge = mergeBorder(ctx, d, r, c);
    if (merge) {
        [rect.top, rect.bottom] = merge.row;
        [rect.left, rect.right] = merge.column;
    }
    return rect;
}

// What the card says and where, worked out from the focus cell on every render.
export function getValidationHint(ctx: Context, r: number, c: number): ValidationHint | undefined {
    const item = getCellDataValidation(ctx, r, c);
    if (!item) return undefined;
    const d = getFlowdata(ctx);
    if (!d) return undefined;

    let kind: ValidationHint['kind'] | undefined;
    let text = '';
    // One card serves both, and a rejection wins because it is more urgent than the prompt.
    if (!isRealNull(getCellValue(r, c, d)) && !cellPassesRule(ctx, item, d[r]?.[c])) {
        kind = 'invalid';
        text = describeValidationRule(item, 'invalid');
    } else if (item.hintShow) {
        kind = 'prompt';
        text = item.hintValue || describeValidationRule(item, 'prompt');
    }
    if (!kind || !text) return undefined;

    const { bottom, left } = cellRectAt(ctx, d, r, c);
    return { kind, text, left, top: bottom };
}

// Moves the hidden list anchor onto the focus cell when its rule is a list, and hides it otherwise.
export function cellFocus(ctx: Context, r: number, c: number) {
    // The list closes for everyone, viewers included. Otherwise a user who lost edit rights would keep a list the last
    // edit session left open.
    ctx.validationListOpen = false;
    if (ctx.allowEdit === false) return;
    const anchor = document.getElementById('sheet-validation-list-anchor');
    if (!anchor) return;
    anchor.style.display = 'none';
    if (getCellDataValidation(ctx, r, c)?.type !== 'dropdown') return;
    const d = getFlowdata(ctx);
    if (!d) return;

    const { top, bottom, left, right } = cellRectAt(ctx, d, r, c);

    anchor.style.display = 'block';
    anchor.style.maxWidth = `${right - left}px`;
    anchor.style.maxHeight = `${bottom - top}px`;
    anchor.style.left = `${right - 20}px`;
    anchor.style.top = `${top + (bottom - top - 20) / 2 - 2}px`;
}

export function setDropdownValue(ctx: Context, value: string, arr: string[]) {
    if (!ctx.selections) return;
    const d = getFlowdata(ctx);
    if (!d) return;
    const last = ctx.selections[ctx.selections.length - 1];
    const rowIndex = last.row_focus;
    const colIndex = last.column_focus;
    if (rowIndex == null || colIndex == null) return;
    const item = getCellDataValidation(ctx, rowIndex, colIndex);
    if (!item) return;
    let nextValue = value;
    if (item.type2 === 'true') {
        nextValue = item.value1
            .split(',')
            .filter((v) => arr.indexOf(v) >= 0)
            .join(',');
    } else {
        ctx.validationListOpen = false;
    }
    setCellValue(ctx, rowIndex, colIndex, d, nextValue);
    jfrefreshgrid(ctx);
}

// What is wrong with the values a data-validation draft compares against, such as a list with no options or a
// range that ends below its start, or undefined when the rule can be applied. The dialog shows it before OK applies.
export function validationValueProblem({ type, type2, value1, value2 }: DataValidationDraft): string | undefined {
    const v1 = parseFloat(value1).toString() !== 'NaN';
    const v2 = parseFloat(value2).toString() !== 'NaN';
    if (type === 'dropdown') {
        if (!value1) return 'The drop-down list option cannot be empty';
    } else if (type === 'checkbox') {
        if (!value1 || !value2) return 'Checkbox content cannot be empty';
    } else if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        if (!v1) return 'The value entered is not a numeric type';
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) return 'The value entered is not a numeric type';
            if (Number(value2) < Number(value1)) return 'The value 2 cannot be less than the value 1';
        }
    } else if (type === 'text_content') {
        if (!value1) return 'The text content cannot be empty';
    } else if (type === 'text_length') {
        if (!v1) return 'The value entered is not a numeric type';
        if (!Number.isInteger(Number(value1)) || Number(value1) < 0)
            return 'Text length must be an integer greater than or equal to 0';
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) return 'The value entered is not a numeric type';
            if (!Number.isInteger(Number(value2)) || Number(value2) < 0)
                return 'Text length must be an integer greater than or equal to 0';
            if (Number(value2) < Number(value1)) return 'The value 2 cannot be less than the value 1';
        }
    } else if (type === 'date') {
        if (!isdatetime(value1)) return 'The value entered is not a date type';
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!isdatetime(value2)) return 'The value entered is not a date type';
            if (diff(value1, value2) > 0) return 'Date 2 cannot be less than date 1';
        }
    }
    return undefined;
}
