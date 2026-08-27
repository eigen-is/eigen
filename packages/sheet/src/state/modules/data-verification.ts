import { isNil } from 'es-toolkit/compat';
import { iscelldata } from '../../engine/formula-utils';
import {
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
import type { en } from '../locale/en';

// Locale slices passed into confirmMessage from the React dialog — the parent
// destructures the `en` locale object into these named groups.
type GeneralDialogLocale = typeof en.generalDialog;
type DataVerificationLocale = typeof en.dataVerification;

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

export const CHECKBOX_CHECKED_VALUE = 'TRUE';
export const CHECKBOX_UNCHECKED_VALUE = 'FALSE';

// Box side in px. Painted on the canvas (render/cells.ts) and hit-tested in the
// mousedown path (events/mouse-cell.ts) from the same checkboxRect geometry —
// same split as the filter button's FILTER_BUTTON_* constants.
export const CHECKBOX_SIZE = 10;
// Gap between the box and the label a custom-value rule keeps.
export const CHECKBOX_LABEL_GAP = 4;
// The painter's space_width/space_height cell padding.
const CHECKBOX_PADDING = 2;

// The cell's own text area: origin plus the width/height the painter lays text
// out in. Callers work in canvas space (painter) or freeze-corrected sheet
// space (hit test) — the box sits at the same offset either way.
export type CellTextBox = { left: number; top: number; width: number; height: number };
// A square glyph placed inside that box: the tick box, the list chevron.
export type CellGlyphRect = { x: number; y: number; size: number };

export function isDefaultCheckboxRule(item: DataVerificationRule) {
    return item.value1 === CHECKBOX_CHECKED_VALUE && item.value2 === CHECKBOX_UNCHECKED_VALUE;
}

export function isCheckboxChecked(item: DataVerificationRule, cellValue: CellValueForValidation) {
    if (isRealNull(cellValue)) return false;
    return String(cellValue).toUpperCase() === item.value1.toUpperCase();
}

// `horizonAlign`/`verticalAlign` are the normalized ht/vt attrs
// (ht 0 centre / 1 left / 2 right, vt 0 middle / 1 top / 2 bottom); an empty
// cell yields NaN, which lands on the same left/middle default the painter uses.
export function checkboxRect(box: CellTextBox, horizonAlign: number, verticalAlign: number): CellGlyphRect {
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

// Only a click on the box toggles — anywhere else in the cell selects it like
// any other, so a tick box can be copied, extended through and read in the fx
// bar without flipping.
export function isCheckboxClick(ctx: Context, r: number, c: number, box: CellTextBox, x: number, y: number) {
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    if (ctx.sheets[index].dataVerification?.[`${r}_${c}`]?.type !== 'checkbox') return false;
    const d = getFlowdata(ctx);
    if (!d) return false;
    const rect = checkboxRect(box, Number(normalizedAttr(d, r, c, 'ht')), Number(normalizedAttr(d, r, c, 'vt')));
    return x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size;
}

// Returns whether the cell actually toggled, so the mouse and keyboard callers
// can fall through to their normal handling when it did not.
export function checkboxChange(ctx: Context, r: number, c: number) {
    if (!isAllowEdit(ctx)) return false;
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const item = ctx.sheets[index].dataVerification?.[`${r}_${c}`];
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
export const DROPDOWN_CHEVRON_SIZE = 10;
const DROPDOWN_CHEVRON_PADDING = 2;
// Click target around the 10px glyph, finger-sized the way the filter button's
// 20×15 rect is around a 12px strainer.
export const DROPDOWN_CHEVRON_HIT_WIDTH = 20;
// The narrowest text box that still gets a chevron: the glyph, its padding, and
// as much again clear to its left. Any narrower and the glyph reads as the
// cell's content rather than a hint about it, so it is dropped — Google's rule.
const DROPDOWN_CHEVRON_MIN_WIDTH = DROPDOWN_CHEVRON_SIZE * 2 + DROPDOWN_CHEVRON_PADDING;

// The one geometry the painter (render/cells.ts) and the mousedown hit-test
// share. Right-aligned and vertically centred whatever the cell's alignment —
// the chevron marks the cell, it is not part of its content.
export function dropdownChevronRect(box: CellTextBox): CellGlyphRect | undefined {
    if (box.width < DROPDOWN_CHEVRON_MIN_WIDTH) return undefined;
    return {
        x: box.left + box.width - DROPDOWN_CHEVRON_PADDING - DROPDOWN_CHEVRON_SIZE,
        y: box.top + (box.height - DROPDOWN_CHEVRON_SIZE) / 2,
        size: DROPDOWN_CHEVRON_SIZE,
    };
}

// Clicking the chevron opens the list, like the canvas filter button opens its
// menu; a click anywhere else in the cell just selects it.
export function isDropdownChevronClick(ctx: Context, r: number, c: number, box: CellTextBox, x: number, y: number) {
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    if (ctx.sheets[index].dataVerification?.[`${r}_${c}`]?.type !== 'dropdown') return false;
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
    let seeded = false;
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        if (!d[r]) continue;
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            rules[`${r}_${c}`] = { ...item };
            if (item.type === 'checkbox' && isRealNull(getRealCellValue(r, c, d))) {
                setCellValue(ctx, r, c, d, item.value2);
                seeded = true;
            }
        }
    }
    ctx.sheets[index].dataVerification = rules;
    if (seeded) jfrefreshgrid(ctx, d, [range]);
}

// Insert -> Tick box: Google's one-click entry, no dialog. Applies to the
// selected range only — a whole-column rule would write a million keys into the
// snapshot. Data -> Data verification keeps the dialog for custom values.
export function insertCheckbox(ctx: Context) {
    const selection = ctx.selections?.[ctx.selections.length - 1];
    if (!selection) return;
    applyDataVerification(
        ctx,
        { row: selection.row, column: selection.column },
        {
            type: 'checkbox',
            type2: '',
            value1: CHECKBOX_CHECKED_VALUE,
            value2: CHECKBOX_UNCHECKED_VALUE,
        },
    );
}

// error message when data is invalid
export function getFailureText(ctx: Context, item: DataVerificationRule) {
    let failureText = '';
    const { type, type2, value1, value2 } = item;
    const optionLabel = ctx.dataVerification?.optionLabel;
    if (!optionLabel) return failureText;

    if (type === 'dropdown') {
        failureText += 'what you selected is not an option in the drop-down list';
    } else if (type === 'checkbox') {
        // checkbox cells can never be invalid — no message
    } else if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        failureText += `what you entered is not a ${optionLabel[type]} ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            failureText += ` and ${value2}`;
        }
    } else if (type === 'text_content') {
        failureText += `what you entered is not text that ${optionLabel[type2]} ${value1}`;
    } else if (type === 'text_length') {
        failureText += `the text you entered is not length ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            failureText += ` and ${value2}`;
        }
    } else if (type === 'date') {
        failureText += `the date you entered is not ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            failureText += ` and ${value2}`;
        }
    }
    return failureText;
}

// get the hint text
export function getHintText(ctx: Context, item: DataVerificationRule) {
    let hintValue = item.hintValue || '';
    if (hintValue) return hintValue;

    const { type, type2, value1, value2 } = item;
    const optionLabel = ctx.dataVerification?.optionLabel;
    if (!optionLabel) return hintValue;

    if (type === 'dropdown') {
        hintValue += 'please select an option in the drop-down list';
    } else if (type === 'checkbox') {
        // checkbox cells need no hint
    } else if (type === 'number' || type === 'number_integer' || type === 'number_decimal') {
        hintValue += `please enter a ${optionLabel[type]} ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            hintValue += ` and ${value2}`;
        }
    } else if (type === 'text_content') {
        hintValue += `please enter text ${optionLabel[type2]} ${value1}`;
    } else if (type === 'text_length') {
        hintValue += `please enter text of length ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            hintValue += ` and ${value2}`;
        }
    } else if (type === 'date') {
        hintValue += `please enter a date ${optionLabel[type2]} ${value1}`;
        if (type2 === 'between' || type2 === 'notBetween') {
            hintValue += ` and ${value2}`;
        }
    }
    return hintValue;
}

// handle cell focus
export function cellFocus(ctx: Context, r: number, c: number) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    const showHintBox = document.getElementById('luckysheet-dataVerification-showHintBox');
    const dropDownBtn = document.getElementById('luckysheet-dataVerification-dropdown-btn');
    ctx.dataVerificationDropDownList = false;
    if (!showHintBox || !dropDownBtn) return;
    showHintBox.style.display = 'none';
    dropDownBtn.style.display = 'none';
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const { dataVerification } = ctx.sheets[index];
    ctx.dataVerificationDropDownList = false;
    if (!dataVerification) return;
    let row = ctx.visibledatarow[r];
    let row_pre = r === 0 ? 0 : ctx.visibledatarow[r - 1];
    let col = ctx.visibledatacolumn[c];
    let col_pre = c === 0 ? 0 : ctx.visibledatacolumn[c - 1];
    const d = getFlowdata(ctx);
    if (!d) return;
    const margeSet = mergeBorder(ctx, d, r, c);
    if (margeSet) {
        [row_pre, row] = margeSet.row;
        [col_pre, col] = margeSet.column;
    }
    const item = dataVerification[`${r}_${c}`];
    if (!item) return;

    // cell data validation type is dropdown
    if (item.type === 'dropdown') {
        dropDownBtn.style.display = 'block';
        dropDownBtn.style.maxWidth = `${col - col_pre}px`;
        dropDownBtn.style.maxHeight = `${row - row_pre}px`;
        dropDownBtn.style.left = `${col - 20}px`;
        dropDownBtn.style.top = `${row_pre + (row - row_pre - 20) / 2 - 2}px`;
    }

    // hint text — checkbox rules have no hint copy, so skip the popup entirely
    // rather than rendering a stranded `Hint: ` label with empty body.
    if (item.hintShow) {
        const hintBody = getHintText(ctx, item);
        if (hintBody) {
            showHintBox.innerHTML = `<span style="color:#f5a623;">Hint: </span>${hintBody}`;
            showHintBox.style.display = 'block';
            showHintBox.style.left = `${col_pre}px`;
            showHintBox.style.top = `${row}px`;
        }
    }

    // data validation failed — show failure reminder (same empty-body guard)
    const cellValue = getCellValue(r, c, d);
    if (isRealNull(cellValue)) {
        return;
    }
    const validate = validateCellData(ctx, item, cellValue);
    if (!validate) {
        const failureBody = getFailureText(ctx, item);
        if (failureBody) {
            showHintBox.innerHTML = `<span style="color:#f72626;">Failure: </span>${failureBody}`;
            showHintBox.style.display = 'block';
            showHintBox.style.left = `${col_pre}px`;
            showHintBox.style.top = `${row}px`;
        }
    }
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
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const item = ctx.sheets[index].dataVerification?.[`${rowIndex}_${colIndex}`];
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
export function confirmMessage(
    ctx: Context,
    generalDialog: GeneralDialogLocale,
    dataVerification: DataVerificationLocale,
): boolean {
    const range = getRangeByTxt(ctx, ctx.dataVerification?.dataRegulation?.rangeTxt as string);
    if (range.length === 0) {
        ctx.warnDialog = generalDialog.noSeletionError;
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
            ctx.warnDialog = dataVerification.tooltipInfo1;
        }
    } else if (verifacationT === 'checkbox') {
        if (!value1 || !value2) {
            ctx.warnDialog = dataVerification.tooltipInfo2;
        }
    } else if (verifacationT === 'number' || verifacationT === 'number_integer' || verifacationT === 'number_decimal') {
        if (!v1) {
            ctx.warnDialog = dataVerification.tooltipInfo3;
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) {
                ctx.warnDialog = dataVerification.tooltipInfo3;
                return false;
            }
            if (Number(value2) < Number(value1)) {
                ctx.warnDialog = dataVerification.tooltipInfo4;
                return false;
            }
        }
    } else if (verifacationT === 'text_content') {
        if (!value1) {
            ctx.warnDialog = dataVerification.tooltipInfo5;
            return false;
        }
    } else if (verifacationT === 'text_length') {
        if (!v1) {
            ctx.warnDialog = dataVerification.tooltipInfo3;
            return false;
        }
        if (!Number.isInteger(Number(value1)) || Number(value1) < 0) {
            ctx.warnDialog = dataVerification.textlengthInteger;
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!v2) {
                ctx.warnDialog = dataVerification.tooltipInfo3;
                return false;
            }
            if (!Number.isInteger(Number(value2)) || Number(value2) < 0) {
                ctx.warnDialog = dataVerification.textlengthInteger;
                return false;
            }
            if (Number(value2) < Number(value1)) {
                ctx.warnDialog = dataVerification.tooltipInfo4;
                return false;
            }
        }
    } else if (verifacationT === 'date') {
        if (!isdatetime(value1)) {
            ctx.warnDialog = dataVerification.tooltipInfo6;
            return false;
        }
        if (type2 === 'between' || type2 === 'notBetween') {
            if (!isdatetime(value2)) {
                ctx.warnDialog = dataVerification.tooltipInfo6;
                return false;
            }
            if (diff(value1, value2) > 0) {
                ctx.warnDialog = dataVerification.tooltipInfo7;
                return false;
            }
        }
    }
    return true;
}
