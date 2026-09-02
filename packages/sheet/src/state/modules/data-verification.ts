import { isNil } from 'es-toolkit/compat';
import { booleanDisplay } from '../../engine/format';
import { iscelldata } from '../../engine/formula-utils';
import {
    type CellMatrix,
    type Context,
    colLocationByIndex,
    type DataVerificationRule,
    diff,
    getCellValue,
    getcellrange,
    getFlowdata,
    getRangeByTxt,
    getRealCellValue,
    getSheetIndex,
    isAllowEdit,
    isdatetime,
    isRealNull,
    isRealNum,
    jfrefreshgrid,
    mergeBorder,
    normalizedAttr,
    rowLocationByIndex,
    type SingleRange,
    setCellValue,
} from '..';
import type { Rect } from '../types';
import { clipToUsedExtent, replaceHtml } from '../utils';

// Lowercase phrase fragments the hint sentences slot into `${type}`/`${condition}`, keyed
// loosely because `type`/`type2` are free-form strings. Text rules get their own frames —
// "Text must equal to ACME" is not a sentence.
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

// Cell value handed to validateCellData by callers. Canvas passes the
// formatted/raw cell value (`Cell['v']` flavour) and `updateCell` in cell.ts
// passes the user-typed innerText.
type CellValueForValidation = string | number | boolean | null | undefined;

// TODO: Add mouse selection for multiple ranges later
// Enable range selection
export function dataRangeSelection(ctx: Context, rangT: string, type: string, value: string) {
    ctx.rangeDialog!.show = true;
    ctx.rangeDialog!.type = type;
    ctx.rangeDialog!.rangeTxt = value;
    if (ctx.selections && rangT) {
        const last = ctx.selections[ctx.selections.length - 1];
        const row_index = last.row_focus as number;
        const col_index = last.column_focus as number;
        ctx.editingCellPosition = [row_index, col_index];

        const range = getRangeByTxt(ctx, rangT);
        const r = range[0]?.row;
        const c = range[0]?.column;
        if (isNil(r) || isNil(c)) return;
        const row_pre = rowLocationByIndex(r[0], ctx.visibledatarow)[0];
        const row = rowLocationByIndex(r[1], ctx.visibledatarow)[1];
        const col_pre = colLocationByIndex(c[0], ctx.visibledatacolumn)[0];
        const col = colLocationByIndex(c[1], ctx.visibledatacolumn)[1];

        ctx.formulaRangeSelect = {
            height: row - row_pre - 1,
            left: col_pre,
            rangeIndex: ctx.formulaRangeSelect?.rangeIndex ?? 0,
            top: row_pre,
            width: col - col_pre - 1,
        };
    } else {
        ctx.editingCellPosition = [0, 0];
    }
}

export function getDropdownList(ctx: Context, txt: string) {
    const list: (string | number | boolean)[] = [];
    if (iscelldata(txt)) {
        const range = getcellrange(ctx, txt);
        const index = getSheetIndex(ctx, range?.sheetId || ctx.currentSheetId) as number;
        const d = ctx.sheets[index].data;
        if (!d || !range) return [];
        for (let r = range.row[0]; r <= range.row[1]; r += 1) {
            for (let c = range.column[0]; c <= range.column[1]; c += 1) {
                if (!d[r]) {
                    continue;
                }

                const cell = d[r][c];

                if (!cell?.v) {
                    continue;
                }

                const v = cell.m || cell.v;

                if (!list.includes(v)) {
                    list.push(v);
                }
            }
        }
    } else {
        const arr = txt.split(',');

        for (let i = 0; i < arr.length; i += 1) {
            const v = arr[i];

            if (v.length === 0) {
                continue;
            }

            if (!list.includes(v)) {
                list.push(v);
            }
        }
    }
    return list;
}

// Data validation
export function validateCellData(ctx: Context, item: DataVerificationRule, cellValue: CellValueForValidation) {
    const { type, type2, value1, value2 } = item;
    if (type === 'dropdown') {
        const list = getDropdownList(ctx, value1);

        // for multi-select, check that each value is in the dropdown list
        if (type2 && cellValue != null && cellValue !== '') {
            return String(cellValue)
                .split(',')
                .every((i) => list.indexOf(i) !== -1);
        }

        if (cellValue == null) return false;
        return list.some((v) => v === cellValue);
    }
    if (type === 'checkbox') {
        return true;
    }
    if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        if (!isRealNum(cellValue)) {
            return false;
        }

        const n = Number(cellValue);
        if (type === 'number_integer' && n % 1 !== 0) {
            return false;
        }

        if (type === 'number_decimal' && n % 1 === 0) {
            return false;
        }

        const v1 = Number(value1);
        const v2 = Number(value2);

        if (type2 === 'between' && (n < v1 || n > v2)) {
            return false;
        }

        if (type2 === 'notBetween' && n >= v1 && n <= v2) {
            return false;
        }

        if (type2 === 'equal' && n !== v1) {
            return false;
        }

        if (type2 === 'notEqualTo' && n === v1) {
            return false;
        }

        if (type2 === 'moreThanThe' && n <= v1) {
            return false;
        }

        if (type2 === 'lessThan' && n >= v1) {
            return false;
        }

        if (type2 === 'greaterOrEqualTo' && n < v1) {
            return false;
        }

        if (type2 === 'lessThanOrEqualTo' && n > v1) {
            return false;
        }
    } else if (type === 'text_content') {
        const s = String(cellValue ?? '');
        const v1 = String(value1 ?? '');

        if (type2 === 'include' && s.indexOf(v1) === -1) {
            return false;
        }

        if (type2 === 'exclude' && s.indexOf(v1) > -1) {
            return false;
        }

        if (type2 === 'equal' && s !== v1) {
            return false;
        }
    } else if (type === 'text_length') {
        const len = String(cellValue ?? '').length;

        const v1 = Number(value1);
        const v2 = Number(value2);

        if (type2 === 'between' && (len < v1 || len > v2)) {
            return false;
        }

        if (type2 === 'notBetween' && len >= v1 && len <= v2) {
            return false;
        }

        if (type2 === 'equal' && len !== v1) {
            return false;
        }

        if (type2 === 'notEqualTo' && len === v1) {
            return false;
        }

        if (type2 === 'moreThanThe' && len <= v1) {
            return false;
        }

        if (type2 === 'lessThan' && len >= v1) {
            return false;
        }

        if (type2 === 'greaterOrEqualTo' && len < v1) {
            return false;
        }

        if (type2 === 'lessThanOrEqualTo' && len > v1) {
            return false;
        }
    } else if (type === 'date') {
        if (!isdatetime(cellValue)) {
            return false;
        }
        // dayjs.ConfigType accepts string|number|Date|Dayjs|null|undefined — coerce
        // the (narrower) cell value to string so the union stays single-shaped.
        const dv = String(cellValue ?? '');

        if (type2 === 'between' && (diff(dv, value1) < 0 || diff(dv, value2) > 0)) {
            return false;
        }

        if (type2 === 'notBetween' && diff(dv, value1) >= 0 && diff(dv, value2) <= 0) {
            return false;
        }

        if (type2 === 'equal' && diff(dv, value1) !== 0) {
            return false;
        }

        if (type2 === 'notEqualTo' && diff(dv, value1) === 0) {
            return false;
        }

        if (type2 === 'earlierThan' && diff(dv, value1) >= 0) {
            return false;
        }

        if (type2 === 'noEarlierThan' && diff(dv, value1) < 0) {
            return false;
        }

        if (type2 === 'laterThan' && diff(dv, value1) <= 0) {
            return false;
        }

        if (type2 === 'noLaterThan' && diff(dv, value1) > 0) {
            return false;
        }
    }
    return true;
}

// --- Tick boxes -------------------------------------------------------------
// The rule names the value that counts as checked; the CELL says whether it is.
// Nothing stores a second flag, so an imported, pasted, typed or
// formula-produced TRUE renders ticked like any other.

// The engine's canonical boolean display, so a formula-produced TRUE reads as
// ticked: recalc writes `cell.m` through the same function.
export const CHECKBOX_CHECKED_VALUE = booleanDisplay(true);
export const CHECKBOX_UNCHECKED_VALUE = booleanDisplay(false);

// Box side in px. Painted on the canvas (render/cells.ts) and hit-tested in the
// mousedown path (events/mouse-cell.ts) from the same checkboxRect geometry —
// same split as the filter button's FILTER_BUTTON_* constants.
export const CHECKBOX_SIZE = 10;
// Gap between the box and the label a custom-value rule keeps.
export const CHECKBOX_LABEL_GAP = 4;
// The painter's space_width/space_height cell padding.
const CHECKBOX_PADDING = 2;

// The cell's own text area is a plain pixel Rect: origin plus the width/height the
// painter lays text out in. Callers work in canvas space (painter) or freeze-corrected
// sheet space (hit test) — the box sits at the same offset either way.
// A square glyph placed inside that box: the tick box, the list chevron.
export type CellGlyphRect = { x: number; y: number; size: number };

// The one construction of that box, from the cell's own bounds. The 1px top
// inset and the 2px the width and height give up are the grid lines the cell
// must not paint over — what the painter has always clipped and laid text out
// to. The hit test used to rebuild the box without the inset, so the top
// painted row of a tick box did not respond to a click and one row below it did.
export function cellTextBox(left: number, top: number, right: number, bottom: number): Rect {
    return { left, top: top + 1, width: right - left - 2, height: bottom - top - 2 };
}

// Whether a tick-box cell draws its value beside the box. A default TRUE/FALSE
// rule draws the box alone, the way Google does, and an empty cell in the range
// draws it alone too so the column reads as one. Anything else keeps its label:
// a custom rule, where it is the only way to tell "Yes" from "No", and any value
// the rule does not name — applying a tick box over a column of prose must not
// paint the prose out of existence.
export function showsCheckboxLabel(item: DataVerificationRule, cellValue: CellValueForValidation) {
    if (item.value1 !== CHECKBOX_CHECKED_VALUE || item.value2 !== CHECKBOX_UNCHECKED_VALUE) return true;
    if (isRealNull(cellValue)) return false;
    const value = String(cellValue).toUpperCase();
    return value !== item.value1.toUpperCase() && value !== item.value2.toUpperCase();
}

export function isCheckboxChecked(item: DataVerificationRule, cellValue: CellValueForValidation) {
    if (isRealNull(cellValue)) return false;
    return String(cellValue).toUpperCase() === item.value1.toUpperCase();
}

// `horizonAlign`/`verticalAlign` are the normalized ht/vt attrs
// (ht 0 centre / 1 left / 2 right, vt 0 middle / 1 top / 2 bottom); an empty
// cell yields NaN, which lands on the same left/middle default the painter uses.
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

// The rule that governs one cell on the current sheet, modelled on the sibling
// getCellHyperlink (modules/hyperlink.ts) — the same lookup was written inline at
// every callsite, most of them casting the sheet index past its not-found case.
export function getCellDataVerification(ctx: Context, r: number, c: number) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null || index < 0) return undefined;
    return ctx.sheets[index].dataVerification?.[`${r}_${c}`];
}

// Only a click on the box toggles — anywhere else in the cell selects it like
// any other, so a tick box can be copied, extended through and read in the fx
// bar without flipping.
export function isCheckboxClick(ctx: Context, r: number, c: number, box: Rect, x: number, y: number) {
    if (getCellDataVerification(ctx, r, c)?.type !== 'checkbox') return false;
    const d = getFlowdata(ctx);
    if (!d) return false;
    const rect = checkboxRect(box, Number(normalizedAttr(d, r, c, 'ht')), Number(normalizedAttr(d, r, c, 'vt')));
    return x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size;
}

// Returns whether the cell actually toggled, so the mouse and keyboard callers
// can fall through to their normal handling when it did not.
export function checkboxChange(ctx: Context, r: number, c: number) {
    if (!isAllowEdit(ctx)) return false;
    const item = getCellDataVerification(ctx, r, c);
    if (item?.type !== 'checkbox') return false;
    const d = getFlowdata(ctx);
    if (!d) return false;
    // A computed check is read-only: writing the literal would eat the formula.
    if (d[r]?.[c]?.f != null) return false;
    const checked = isCheckboxChecked(item, getRealCellValue(r, c, d));
    setCellValue(ctx, r, c, d, checked ? item.value2 : item.value1);
    // Same tail as the dropdown's selectDataVerificationValue: the write has to
    // kick dependent formulas, and the mousedown path has not moved the
    // selection here yet, so name the toggled cell explicitly.
    jfrefreshgrid(ctx, d, [{ row: [r, r], column: [c, c] }]);
    return true;
}

// --- List chevrons ---------------------------------------------------------
// A list rule paints its chevron on every cell it covers, always — the same
// deal every other affordance in this engine offers (comment triangle, tick
// box, filter button). Selection-gating it, as the DOM overlay it replaced did,
// left keyboard users and read-only viewers with no indicator at all.

// Glyph side in px, and its gap from the cell's right edge.
export const DROPDOWN_CHEVRON_SIZE = 8;
const DROPDOWN_CHEVRON_PADDING = 2;
// Click target around the 8px glyph, finger-sized the way the filter button's
// 20×15 rect is around a 12px strainer.
export const DROPDOWN_CHEVRON_HIT_WIDTH = 20;
// The narrowest text box that still gets a chevron: the glyph, its padding, and
// as much again clear to its left. Any narrower and the glyph reads as the
// cell's content rather than a hint about it, so it is dropped — Google's rule.
const DROPDOWN_CHEVRON_MIN_WIDTH = DROPDOWN_CHEVRON_SIZE * 2 + DROPDOWN_CHEVRON_PADDING;

// The one geometry the painter (render/cells.ts) and the mousedown hit-test
// share. Right-aligned and vertically centred whatever the cell's alignment —
// the chevron marks the cell, it is not part of its content.
export function dropdownChevronRect(box: Rect): CellGlyphRect | undefined {
    if (box.width < DROPDOWN_CHEVRON_MIN_WIDTH) return undefined;
    return {
        x: box.left + box.width - DROPDOWN_CHEVRON_PADDING - DROPDOWN_CHEVRON_SIZE,
        y: box.top + (box.height - DROPDOWN_CHEVRON_SIZE) / 2,
        size: DROPDOWN_CHEVRON_SIZE,
    };
}

// Clicking the chevron opens the list, like the canvas filter button opens its
// menu; a click anywhere else in the cell just selects it.
export function isDropdownChevronClick(ctx: Context, r: number, c: number, box: Rect, x: number, y: number) {
    if (getCellDataVerification(ctx, r, c)?.type !== 'dropdown') return false;
    const rect = dropdownChevronRect(box);
    if (!rect) return false;
    const right = rect.x + rect.size;
    return x >= right - DROPDOWN_CHEVRON_HIT_WIDTH && x <= right && y >= box.top && y <= box.top + box.height;
}

// Apply one rule across a range. Tick boxes seed their unchecked value into
// EMPTY cells only — pointing a tick box at a column of existing TRUE/FALSE
// must keep the data; isCheckboxChecked reads whatever was already there.
export function applyDataVerification(ctx: Context, range: SingleRange, item: DataVerificationRule) {
    if (!isAllowEdit(ctx)) return;
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const d = getFlowdata(ctx);
    if (!d) return;
    const rules = ctx.sheets[index].dataVerification ?? {};
    // One clone for the whole range: the rules are read-only to everything that
    // consumes them, paste and drop-cell already alias one rule across cells, and
    // the serialized snapshot is the same either way.
    const rule = { ...item };
    let seeded = false;
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        if (!d[r]) continue;
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            rules[`${r}_${c}`] = rule;
            if (item.type === 'checkbox' && isRealNull(getRealCellValue(r, c, d))) {
                setCellValue(ctx, r, c, d, item.value2);
                seeded = true;
            }
        }
    }
    ctx.sheets[index].dataVerification = rules;
    if (seeded) jfrefreshgrid(ctx, d, [range]);
}

// Insert -> Tick box: Google's one-click entry, no dialog. There is nowhere to
// reconsider the selection, so a header click is bounded to the used extent
// (clipToUsedExtent) — past it a tick box marks nothing — while a range the user
// dragged out can still lay a checklist over empty cells. Data -> Data
// verification keeps the dialog.
export function insertCheckbox(ctx: Context) {
    const selection = ctx.selections?.[ctx.selections.length - 1];
    if (!selection) return;
    applyDataVerification(ctx, clipToUsedExtent(ctx, [selection])[0], {
        type: 'checkbox',
        type2: '',
        value1: CHECKBOX_CHECKED_VALUE,
        value2: CHECKBOX_UNCHECKED_VALUE,
    });
}

// --- The in-grid validation card -------------------------------------------
// What a validated cell has to say: why the value in it was rejected, or what
// to type. Copy lives in the locale next to the rest of the dialog's strings;
// the sentence frames slot in a rule-type word and a condition phrase.

export type ValidationHint = {
    kind: 'invalid' | 'prompt';
    text: string;
    // Content coordinates of the cell's bottom-left corner — the card hangs
    // under the cell, merge extent included.
    left: number;
    top: number;
};

// "between 1 and 10", "greater than 5", "earlier than 2024-01-01".
function conditionPhrase(item: DataVerificationRule) {
    const { type2, value1, value2 } = item;
    const label = OPTION_LABEL[type2];
    if (!label) return '';
    if (type2 === 'between' || type2 === 'notBetween') return `${label} ${value1} and ${value2}`;
    return `${label} ${value1}`;
}

// Every rule type gets two sentences: why the value in the cell was rejected, and what to
// type instead.
const HINT_FRAMES = {
    listInvalid: 'Input must be an item on the specified list.',
    listPrompt: 'Pick an item from the list.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    numberInvalid: 'Input must be ${type} ${condition}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    numberPrompt: 'Enter ${type} ${condition}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textIncludeInvalid: 'Text must include ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textIncludePrompt: 'Enter text that includes ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textExcludeInvalid: 'Text must not include ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textExcludePrompt: 'Enter text that does not include ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textEqualInvalid: 'Text must be ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    textEqualPrompt: 'Enter ${value}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    lengthInvalid: 'Text length must be ${condition}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    lengthPrompt: 'Enter text of length ${condition}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    dateInvalid: 'Date must be ${condition}.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${name} placeholders consumed by replaceHtml() at runtime, not JS template syntax
    datePrompt: 'Enter a date ${condition}.',
};

// Also the copy for the `prohibitInput` warn dialog (modules/cell.ts), so the
// two ways a rejected value is reported say the same thing.
export function describeValidationRule(item: DataVerificationRule, kind: ValidationHint['kind']) {
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
    // A tick box can never hold an invalid value and needs no prompt: no frame,
    // no card.
    if (!frame) return '';

    // replaceHtml, not chained String.replace: a rule's value is authored by a
    // collaborator or carried in from an xlsx, and `$&`/`$1` in a replacement string
    // are substitution patterns rather than literal text.
    return replaceHtml(frame, {
        type: OPTION_LABEL[type] ?? '',
        condition: conditionPhrase(item),
        value: item.value1,
    });
}

// The cell's content-space rectangle, merge extent included — the card hangs off
// its bottom-left corner and the hidden dropdown anchor sits in it.
function cellRectAt(ctx: Context, d: CellMatrix, r: number, c: number) {
    const rect = {
        top: r === 0 ? 0 : ctx.visibledatarow[r - 1],
        bottom: ctx.visibledatarow[r],
        left: c === 0 ? 0 : ctx.visibledatacolumn[c - 1],
        right: ctx.visibledatacolumn[c],
    };
    const margeSet = mergeBorder(ctx, d, r, c);
    if (margeSet) {
        [rect.top, rect.bottom] = margeSet.row;
        [rect.left, rect.right] = margeSet.column;
    }
    return rect;
}

// The card's whole model — what to say and where — derived from the cell on
// every render. It replaces a singleton div that a mousedown handler wrote with
// innerHTML and positioned in raw pixels: that one stranded over the previous
// cell when you arrowed away, never appeared for a keyboard user, and put any
// collaborator's rule text into markup.
export function getValidationHint(ctx: Context, r: number, c: number): ValidationHint | undefined {
    const item = getCellDataVerification(ctx, r, c);
    if (!item) return undefined;
    const d = getFlowdata(ctx);
    if (!d) return undefined;

    const cellValue = getCellValue(r, c, d);
    let kind: ValidationHint['kind'] | undefined;
    let text = '';
    // A rejection outranks the prompt — it is the more urgent of the two, and
    // one card serves both.
    if (!isRealNull(cellValue) && !validateCellData(ctx, item, cellValue)) {
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

// handle cell focus
export function cellFocus(ctx: Context, r: number, c: number) {
    // Reset first, whoever is looking: a viewer who arrives after a permission
    // change would otherwise be stuck with whatever the last edit session left.
    ctx.dataVerificationDropDownList = false;
    if (!isAllowEdit(ctx)) return;
    const dropDownBtn = document.getElementById('sheet-dataVerification-dropdown-btn');
    if (!dropDownBtn) return;
    dropDownBtn.style.display = 'none';
    if (getCellDataVerification(ctx, r, c)?.type !== 'dropdown') return;
    const d = getFlowdata(ctx);
    if (!d) return;

    const { top, bottom, left, right } = cellRectAt(ctx, d, r, c);

    // The Radix anchor, not an indicator: the chevron is canvas paint.
    dropDownBtn.style.display = 'block';
    dropDownBtn.style.maxWidth = `${right - left}px`;
    dropDownBtn.style.maxHeight = `${bottom - top}px`;
    dropDownBtn.style.left = `${right - 20}px`;
    dropDownBtn.style.top = `${top + (bottom - top - 20) / 2 - 2}px`;
}

// set the dropdown value
export function setDropdownValue(ctx: Context, value: string, arr: string[]) {
    if (!ctx.selections) return;
    const d = getFlowdata(ctx);
    if (!d) return;
    const last = ctx.selections[ctx.selections.length - 1];
    const rowIndex = last.row_focus;
    const colIndex = last.column_focus;
    if (rowIndex == null || colIndex == null) return;
    const item = getCellDataVerification(ctx, rowIndex, colIndex);
    if (!item) return;
    let nextValue = value;
    if (item.type2 === 'true') {
        nextValue = item.value1
            .split(',')
            .filter((v) => arr.indexOf(v) >= 0)
            .join(',');
    } else {
        ctx.dataVerificationDropDownList = false;
    }
    setCellValue(ctx, rowIndex, colIndex, d, nextValue);
    jfrefreshgrid(ctx, null, undefined);
}

// input data validation
export function confirmMessage(ctx: Context): boolean {
    const range = getRangeByTxt(ctx, ctx.dataVerification?.dataRegulation?.rangeTxt as string);
    if (range.length === 0) {
        ctx.warnDialog = 'The selection operation has not been performed yet';
        return false;
    }
    let str = range[range.length - 1]?.row[0];
    let edr = range[range.length - 1]?.row[1];
    let stc = range[range.length - 1]?.column[0];
    let edc = range[range.length - 1]?.column[1];
    const d = getFlowdata(ctx);
    if (!d || isNil(str) || isNil(edr) || isNil(stc) || isNil(edc)) return false;
    if (str < 0) {
        str = 0;
    }
    if (edr > d.length - 1) {
        edr = d.length - 1;
    }
    if (stc < 0) {
        stc = 0;
    }
    if (edc > d[0].length - 1) {
        edc = d[0].length - 1;
    }
    const regulation = ctx.dataVerification!.dataRegulation!;
    const verifacationT = regulation?.type;
    const { value1, value2, type2 } = regulation;
    // check if the value is a number
    const v1 = parseFloat(value1).toString() !== 'NaN';
    const v2 = parseFloat(value2).toString() !== 'NaN';
    if (verifacationT === 'dropdown') {
        if (!value1) {
            ctx.warnDialog = 'The drop-down list option cannot be empty';
            return false;
        }
    } else if (verifacationT === 'checkbox') {
        if (!value1 || !value2) {
            ctx.warnDialog = 'Checkbox content cannot be empty';
            return false;
        }
    } else if (verifacationT === 'number' || verifacationT === 'number_integer' || verifacationT === 'number_decimal') {
        if (!v1) {
            ctx.warnDialog = 'The value entered is not a numeric type';
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) {
                ctx.warnDialog = 'The value entered is not a numeric type';
                return false;
            }
            if (Number(value2) < Number(value1)) {
                ctx.warnDialog = 'The value 2 cannot be less than the value 1';
                return false;
            }
        }
    } else if (verifacationT === 'text_content') {
        if (!value1) {
            ctx.warnDialog = 'The text content cannot be empty';
            return false;
        }
    } else if (verifacationT === 'text_length') {
        if (!v1) {
            ctx.warnDialog = 'The value entered is not a numeric type';
            return false;
        }
        if (!Number.isInteger(Number(value1)) || Number(value1) < 0) {
            ctx.warnDialog = 'Text length must be an integer greater than or equal to 0';
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) {
                ctx.warnDialog = 'The value entered is not a numeric type';
                return false;
            }
            if (!Number.isInteger(Number(value2)) || Number(value2) < 0) {
                ctx.warnDialog = 'Text length must be an integer greater than or equal to 0';
                return false;
            }
            if (Number(value2) < Number(value1)) {
                ctx.warnDialog = 'The value 2 cannot be less than the value 1';
                return false;
            }
        }
    } else if (verifacationT === 'date') {
        if (!isdatetime(value1)) {
            ctx.warnDialog = 'The value entered is not a date type';
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!isdatetime(value2)) {
                ctx.warnDialog = 'The value entered is not a date type';
                return false;
            }
            if (diff(value1, value2) > 0) {
                ctx.warnDialog = 'Date 2 cannot be less than date 1';
                return false;
            }
        }
    }
    return true;
}
