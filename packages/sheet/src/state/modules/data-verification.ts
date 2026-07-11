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
    getSheetIndex,
    isAllowEdit,
    isdatetime,
    isRealNull,
    isRealNum,
    jfrefreshgrid,
    mergeBorder,
    rowLocationByIndex,
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
    if (ctx.selections && !!rangT) {
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

// ID card validation
export function validateIdCard(idCard: string) {
    // regex for 15-digit and 18-digit Chinese ID card numbers
    const regIdCard =
        /^(^[1-9]\d{7}((0\d)|(1[0-2]))(([0|1|2]\d)|3[0-1])\d{3}$)|(^[1-9]\d{5}[1-9]\d{3}((0\d)|(1[0-2]))(([0|1|2]\d)|3[0-1])((\d{4})|\d{3}[Xx])$)$/;

    // if this passes, the ID card format is correct, but accuracy still needs to be calculated
    if (regIdCard.test(idCard)) {
        if (idCard.length === 18) {
            const idCardWi = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]; // store the weighting factors for the first 17 digits in an array
            const idCardY = [1, 0, 10, 9, 8, 7, 6, 5, 4, 3, 2]; // the 11 possible remainders after dividing by 11 (check digits), also stored as array
            let idCardWiSum = 0; // stores the sum of the first 17 digits each multiplied by their weighting factor
            for (let i = 0; i < 17; i += 1) {
                idCardWiSum += Number(idCard.substring(i, i + 1)) * idCardWi[i];
            }

            const idCardMod = idCardWiSum % 11; // calculate the array index of the check digit
            const idCardLast = idCard.substring(17); // get the last digit of the ID card

            // if equals 2, the check digit is 10, so the last character of the ID card should be X
            if (idCardMod === 2) {
                if (idCardLast === 'X' || idCardLast === 'x') {
                    return true;
                }
                return false;
            }
            // match the computed check digit with the last character; if they match it is valid, otherwise the ID card is invalid
            if (idCardLast === idCardY[idCardMod].toString()) {
                return true;
            }
            return false;
        }
    } else {
        return false;
    }
    return false;
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
    } else if (type === 'validity') {
        const s = String(cellValue ?? '');
        if (type2 === 'identificationNumber' && !validateIdCard(s)) {
            return false;
        }

        if (type2 === 'phoneNumber' && !/^1[3456789]\d{9}$/.test(s)) {
            return false;
        }
    }
    return true;
}

// checkbox handling
export function checkboxChange(ctx: Context, r: number, c: number) {
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const currentDataVerification = ctx.sheets[index].dataVerification ?? {};
    const item = currentDataVerification[`${r}_${c}`];
    item.checked = !item.checked;
    const value = item.checked ? item.value1 : item.value2;
    const d = getFlowdata(ctx);
    setCellValue(ctx, r, c, d, value);
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
    } else if (type === 'validity') {
        failureText += `what you entered is not a correct ${optionLabel[type2]}`;
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
    } else if (type === 'validity') {
        hintValue += `please enter the correct ${optionLabel[type2]}`;
    }
    return hintValue;
}

// handle cell focus
export function cellFocus(ctx: Context, r: number, c: number, clickMode: boolean) {
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

    // cell data validation type is checkbox
    if (clickMode && item.type === 'checkbox') {
        checkboxChange(ctx, r, c);
    }

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
