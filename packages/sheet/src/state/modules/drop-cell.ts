import type { CellBorderInfo } from '@workspace/lib/sheets';
import dayjs from 'dayjs';
import { cloneDeep, pick } from 'es-toolkit/compat';
import { cfSplitRange } from '../../engine/conditional-format';
import { genarate, update } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { Cell, CellMatrix, SingleRange } from '../../engine/types';
import { type Context, getFlowdata, getSheetConfig } from '../context';
import type { Rect } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import { getBorderInfoCompute } from './border';
import { createContextResolver } from './formula-cache';
import { execFunctionGroup, execfunction } from './formula-exec';
import { colLocation, rowLocation } from './location';
import { jfrefreshgrid } from './refresh';
import { normalizeSelection } from './selection';
import { isRealNum } from './validation';

function toPx(v: number) {
    return `${v}px`;
}

// Drag-fill direction. The four cardinal values match how the user dragged the
// fill handle; null is the initial state before any drag.
type DropDirection = 'down' | 'up' | 'left' | 'right';

// applyType values used as discriminators throughout the autofill heuristics:
//   '0' = copy cells, '1' = fill series, '2' = fill format only,
//   '3' = fill without format, '4' = fill by days, '5' = fill by weekdays,
//   '6' = fill by months, '7' = fill by years, '8' = Chinese lowercase numbers.
type DropApplyType = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

// Module-scope cache of the in-progress drag-fill operation. Constants
// (chnNumChar/chnNameValue/…) live alongside the mutable copyRange/applyRange/
// applyType/direction state so callers in api/cell.ts can prime everything in
// one place. Producers fill copyRange/applyRange/direction before
// `updateDropCell` reads them; first run leaves them as the empty-object
// initial values, hence the partial `SingleRange` on the cache.
type DropCellCache = {
    copyRange: SingleRange;
    applyRange: SingleRange;
    applyType: DropApplyType | null;
    direction: DropDirection | null;
    chnNumChar: Record<string, number>;
    chnNameValue: Record<string, { value: number; secUnit: boolean }>;
    chnNumChar2: string[];
    chnUnitSection: string[];
    chnUnitChar: string[];
};

export const dropCellCache: DropCellCache = {
    copyRange: { row: [], column: [] },
    applyRange: { row: [], column: [] },
    applyType: null,
    direction: null,
    chnNumChar: {
        零: 0,
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
    },
    chnNameValue: {
        十: { value: 10, secUnit: false },
        百: { value: 100, secUnit: false },
        千: { value: 1000, secUnit: false },
        万: { value: 10000, secUnit: true },
        亿: { value: 100000000, secUnit: true },
    },
    chnNumChar2: ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'],
    chnUnitSection: ['', '万', '亿', '万亿', '亿亿'],
    chnUnitChar: ['', '十', '百', '千'],
};

function chineseToNumber(chnStr: string) {
    let rtn = 0;
    let section = 0;
    let number = 0;
    let secUnit = false;
    const str = chnStr.split('');

    for (let i = 0; i < str.length; i += 1) {
        const num = dropCellCache.chnNumChar[str[i]];

        if (typeof num !== 'undefined') {
            number = num;

            if (i === str.length - 1) {
                section += number;
            }
        } else {
            const unit = dropCellCache.chnNameValue[str[i]].value;
            secUnit = dropCellCache.chnNameValue[str[i]].secUnit;

            if (secUnit) {
                section = (section + number) * unit;
                rtn += section;
                section = 0;
            } else {
                section += number * unit;
            }

            number = 0;
        }
    }

    return rtn + section;
}

function sectionToChinese(section: number) {
    let strIns = '';
    let chnStr = '';
    let unitPos = 0;
    let zero = true;

    while (section > 0) {
        const v = section % 10;

        if (v === 0) {
            if (!zero) {
                zero = true;
                chnStr = dropCellCache.chnNumChar2[v] + chnStr;
            }
        } else {
            zero = false;
            strIns = dropCellCache.chnNumChar2[v];
            strIns += dropCellCache.chnUnitChar[unitPos];
            chnStr = strIns + chnStr;
        }

        unitPos += 1;
        section = Math.floor(section / 10);
    }

    return chnStr;
}

function numberToChinese(num: number) {
    let strIns = '';
    let chnStr = '';
    let unitPos = 0;
    let needZero = false;

    if (num === 0) {
        return dropCellCache.chnNumChar2[0];
    }
    while (num > 0) {
        const section = num % 10000;

        if (needZero) {
            chnStr = dropCellCache.chnNumChar2[0] + chnStr;
        }

        strIns = sectionToChinese(section);
        strIns += section !== 0 ? dropCellCache.chnUnitSection[unitPos] : dropCellCache.chnUnitSection[0];
        chnStr = strIns + chnStr;
        needZero = section < 1000 && section > 0;
        num = Math.floor(num / 10000);
        unitPos += 1;
    }

    return chnStr;
}

function isChnNumber(txt: string | number | undefined) {
    if (typeof txt === 'number') {
        txt = `${txt}`;
    }
    let result = true;

    if (txt == null) {
        result = false;
    } else if (txt.length === 1) {
        if (txt === '日' || txt in dropCellCache.chnNumChar) {
            result = true;
        } else {
            result = false;
        }
    } else {
        const str = txt.split('');
        for (let i = 0; i < str.length; i += 1) {
            if (!(str[i] in dropCellCache.chnNumChar || str[i] in dropCellCache.chnNameValue)) {
                result = false;
                break;
            }
        }
    }

    return result;
}

function isExtendNumber(txt: string | number | undefined) {
    if (txt == null) return [false];
    if (typeof txt === 'number') {
        txt = `${txt}`;
    }
    const reg = /0|([1-9]+[0-9]*)/g;
    const result = reg.test(txt);

    if (result) {
        const match = txt.match(reg);
        if (match) {
            const matchTxt = match[match.length - 1];
            const matchIndex = txt.lastIndexOf(matchTxt);
            const beforeTxt = txt.slice(0, matchIndex);
            const afterTxt = txt.slice(matchIndex + matchTxt.length);

            return [result, Number(matchTxt), beforeTxt, afterTxt];
        }
    }

    return [result];
}

function isChnWeek2(txt: string | number | undefined) {
    let result = false;
    if (typeof txt === 'number') {
        txt = `${txt}`;
    }
    if (txt !== undefined && txt.length === 2) {
        if (
            txt === '周一' ||
            txt === '周二' ||
            txt === '周三' ||
            txt === '周四' ||
            txt === '周五' ||
            txt === '周六' ||
            txt === '周日'
        ) {
            result = true;
        }
    }

    return result;
}

function isChnWeek3(txt: string | number | undefined) {
    if (typeof txt === 'number') {
        txt = `${txt}`;
    }
    let result = false;
    if (txt !== undefined && txt.length === 3) {
        if (
            txt === '星期一' ||
            txt === '星期二' ||
            txt === '星期三' ||
            txt === '星期四' ||
            txt === '星期五' ||
            txt === '星期六' ||
            txt === '星期日'
        ) {
            result = true;
        }
    }
    return result;
}

function isEqualDiff(arr: number[]) {
    let diff = true;
    const step = arr[1] - arr[0];

    for (let i = 1; i < arr.length; i += 1) {
        if (arr[i] - arr[i - 1] !== step) {
            diff = false;
            break;
        }
    }

    return diff;
}

function isEqualRatio(arr: number[]) {
    let ratio = true;
    const step = arr[1] / arr[0];

    for (let i = 1; i < arr.length; i += 1) {
        if (arr[i] / arr[i - 1] !== step) {
            ratio = false;
            break;
        }
    }

    return ratio;
}

function getXArr(len: number) {
    const xArr = [];

    for (let i = 1; i <= len; i += 1) {
        xArr.push(i);
    }

    return xArr;
}

function forecast(x: number, yArr: number[], xArr: number[]) {
    function getAverage(arr: number[]) {
        let sum = 0;

        for (let i = 0; i < arr.length; i += 1) {
            sum += arr[i];
        }

        return sum / arr.length;
    }

    const ax = getAverage(xArr); // average of x array
    const ay = getAverage(yArr); // average of y array

    let sum_d = 0;
    let sum_n = 0;
    for (let j = 0; j < xArr.length; j += 1) {
        // sum of denominators
        sum_d += (xArr[j] - ax) * (yArr[j] - ay);
        // sum of numerators
        sum_n += (xArr[j] - ax) * (xArr[j] - ax);
    }

    const b = sum_n === 0 ? 1 : sum_d / sum_n;

    const a = ay - b * ax;

    return Math.round((a + b * x) * 100000) / 100000;
}

function judgeDate(data: (Cell | null | undefined)[]) {
    let isSameDay = true;
    let isSameMonth = true;
    let isEqualDiffDays = true;
    let isEqualDiffMonths = true;
    let isEqualDiffYears = true;
    if (data[0] == null || data[1] == null) return [false, false, false, false, false];
    const sameDay = dayjs(data[0].m).date();
    const sameMonth = dayjs(data[0].m).month();
    const equalDiffDays = dayjs(data[1].m).diff(dayjs(data[0].m), 'days');
    const equalDiffMonths = dayjs(data[1].m).diff(dayjs(data[0].m), 'months');
    const equalDiffYears = dayjs(data[1].m).diff(dayjs(data[0].m), 'years');

    for (let i = 1; i < data.length; i += 1) {
        // check if the day is the same
        if (dayjs(data[i]?.m).date() !== sameDay) {
            isSameDay = false;
        }
        // check if the month is the same
        if (dayjs(data[i]?.m).month() !== sameMonth) {
            isSameMonth = false;
        }
        // check if the day difference is an arithmetic sequence
        if (dayjs(data[i]?.m).diff(dayjs(data[i - 1]?.m), 'days') !== equalDiffDays) {
            isEqualDiffDays = false;
        }
        // check if the month difference is an arithmetic sequence
        if (dayjs(data[i]?.m).diff(dayjs(data[i - 1]?.m), 'months') !== equalDiffMonths) {
            isEqualDiffMonths = false;
        }
        // check if the year difference is an arithmetic sequence
        if (dayjs(data[i]?.m).diff(dayjs(data[i - 1]?.m), 'years') !== equalDiffYears) {
            isEqualDiffYears = false;
        }
    }

    if (equalDiffDays === 0) {
        isEqualDiffDays = false;
    }
    if (equalDiffMonths === 0) {
        isEqualDiffMonths = false;
    }
    if (equalDiffYears === 0) {
        isEqualDiffYears = false;
    }

    return [isSameDay, isSameMonth, isEqualDiffDays, isEqualDiffMonths, isEqualDiffYears];
}

// The extend preview renders once per overlay pane region; write every copy —
// each region's clip shows exactly its portion.
export function showDropCellSelection({ width, height, top, left }: Rect, container: HTMLDivElement) {
    for (const selectedExtend of container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-extend')) {
        selectedExtend.style.left = toPx(left);
        selectedExtend.style.width = toPx(width);
        selectedExtend.style.top = toPx(top);
        selectedExtend.style.height = toPx(height);
        selectedExtend.style.display = 'block';
    }
}

export function hideDropCellSelection(container: HTMLDivElement) {
    for (const selectedExtend of container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-extend')) {
        selectedExtend.style.display = 'none';
    }
}

export function createDropCellRange(ctx: Context, e: MouseEvent, container: HTMLDivElement) {
    ctx.cellSelectExtending = true;
    ctx.scrolling = true;

    const { scrollLeft, scrollTop } = ctx;
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop;

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row_pre = row_location[0];
    const row = row_location[1];
    const row_index = row_location[2];
    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col_pre = col_location[0];
    const col = col_location[1];
    const col_index = col_location[2];

    ctx.cellSelectExtendIndex = [row_index, col_index];

    showDropCellSelection(
        {
            left: col_pre,
            width: col - col_pre - 1,
            top: row_pre,
            height: row - row_pre - 1,
        },
        container,
    );
}

export function onDropCellSelect(ctx: Context, e: MouseEvent, scrollEl: HTMLDivElement, container: HTMLDivElement) {
    const { scrollLeft, scrollTop } = scrollEl;
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop;

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];
    const row_pre = row_location[0];
    const row_index = row_location[2];
    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];
    const col_pre = col_location[0];
    const col_index = col_location[2];

    const row_index_original = ctx.cellSelectExtendIndex[0];
    const col_index_original = ctx.cellSelectExtendIndex[1];

    if (!ctx.selections) return;
    let row_s = ctx.selections[0].row[0];
    let row_e = ctx.selections[0].row[1];
    let col_s = ctx.selections[0].column[0];
    let col_e = ctx.selections[0].column[1];

    let top = ctx.selections[0].top_move;
    let height = ctx.selections[0].height_move;
    let left = ctx.selections[0].left_move;
    let width = ctx.selections[0].width_move;

    if (top == null || height == null || left == null || width == null) return;
    if (Math.abs(row_index_original - row_index) > Math.abs(col_index_original - col_index)) {
        if (!(row_index >= row_s && row_index <= row_e)) {
            if (top >= row_pre) {
                height += top - row_pre;
                top = row_pre;
            } else {
                height = row - top - 1;
            }
        }
    } else {
        if (!(col_index >= col_s && col_index <= col_e)) {
            if (left >= col_pre) {
                width += left - col_pre;
                left = col_pre;
            } else {
                width = col - left - 1;
            }
        }
    }
    if (y < 0) {
        row_s = 0;
        [row_e] = ctx.selections[0].row;
    }
    if (x < 0) {
        col_s = 0;
        [col_e] = ctx.selections[0].column;
    }

    showDropCellSelection({ left, width, top, height }, container);
}

function fillCopy(data: (Cell | null | undefined)[], len: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);
        if (d !== undefined) {
            applyData.push(d);
        }
    }

    return applyData;
}

function fillSeries(data: (Cell | null | undefined)[], len: number, direction: string) {
    const applyData: Cell[] = [];

    const dataNumArr = [];
    for (let j = 0; j < data.length; j += 1) {
        const d = cloneDeep(data[j]);
        if (d != null) {
            dataNumArr.push(Number(d.v));
        }
    }

    if (data.length > 2 && isEqualRatio(dataNumArr) && data[0] != null && data[1] != null) {
        // geometric sequence
        for (let i = 1; i <= len; i += 1) {
            const index = (i - 1) % data.length;
            const d = cloneDeep(data[index]);

            if (d != null) {
                let num: number;
                if (direction === 'down' || direction === 'right') {
                    num = Number(data[data.length - 1]!.v) * (Number(data[1].v) / Number(data[0].v)) ** i;
                } else {
                    //  direction == "up" || direction == "left"
                    num = Number(data[0].v) / (Number(data[1].v) / Number(data[0].v)) ** i;
                }

                d.v = num;
                if (d.ct != null && d.ct.fa != null) {
                    d.m = update(d.ct.fa, num);
                }
                applyData.push(d);
            }
        }
    } else {
        // linear sequence
        const xArr = getXArr(data.length);
        for (let i = 1; i <= len; i += 1) {
            const index = (i - 1) % data.length;
            const d = cloneDeep(data[index]);
            if (d != null) {
                let y: number | undefined;
                if (direction === 'down' || direction === 'right') {
                    y = forecast(data.length + i, dataNumArr, xArr);
                } else if (direction === 'up' || direction === 'left') {
                    y = forecast(1 - i, dataNumArr, xArr);
                }

                d.v = y;
                if (d.ct != null && d.ct.fa != null) {
                    d.m = update(d.ct.fa, y);
                }
                applyData.push(d);
            }
        }
    }

    return applyData;
}

function fillExtendNumber(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];
    const reg = /0|([1-9]+[0-9]*)/g;

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);
        let last = data[data.length - 1]?.m;
        if (d != null && last != null) {
            last = `${last}`;
            const match = last.match(reg) || '';
            const lastTxt = match[match.length - 1];

            const num = Math.abs(Number(lastTxt) + step * i);
            const lastIndex = last.lastIndexOf(lastTxt);
            const valueTxt = last.slice(0, lastIndex) + num.toString() + last.slice(lastIndex + lastTxt.length);

            d.v = valueTxt;
            d.m = valueTxt;

            applyData.push(d);
        }
    }

    return applyData;
}

function fillDays(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const d = cloneDeep(data[data.length - 1]);
        if (d != null) {
            let date = update('yyyy-MM-dd', d.v);
            date = dayjs(date)
                .add(step * i, 'days')
                .format('YYYY-MM-DD');

            // TODO: is this genarate() call handled correctly?
            d.v = genarate(date)[2];
            if (d.ct != null && d.ct.fa != null) {
                d.m = update(d.ct.fa, d.v);
            }

            applyData.push(d);
        }
    }

    return applyData;
}

function fillMonths(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const d = cloneDeep(data[data.length - 1]);
        if (d != null) {
            let date = update('yyyy-MM-dd', d.v);
            date = dayjs(date)
                .add(step * i, 'months')
                .format('YYYY-MM-DD');

            d.v = genarate(date)[2];
            if (d.ct != null && d.ct.fa != null) {
                d.m = update(d.ct.fa, d.v);
            }

            applyData.push(d);
        }
    }

    return applyData;
}

function fillYears(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const d = cloneDeep(data[data.length - 1]);
        if (d != null) {
            let date = update('yyyy-MM-dd', d.v);
            date = dayjs(date)
                .add(step * i, 'years')
                .format('YYYY-MM-DD');

            d.v = genarate(date)[2];
            if (d.ct != null && d.ct.fa != null) {
                d.m = update(d.ct.fa, d.v);
            }
        }

        applyData.push(d);
    }

    return applyData;
}

function fillChnWeek(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);

        let num: number;
        const m = data[data.length - 1]?.m;
        if (m != null && d != null) {
            if (m === '日') {
                num = 7 + step * i;
            } else {
                num = chineseToNumber(`${m}`) + step * i;
            }

            if (num < 0) {
                num = Math.ceil(Math.abs(num) / 7) * 7 + num;
            }

            const rsd = num % 7;
            if (rsd === 0) {
                d.m = '日';
                d.v = '日';
            } else if (rsd === 1) {
                d.m = '一';
                d.v = '一';
            } else if (rsd === 2) {
                d.m = '二';
                d.v = '二';
            } else if (rsd === 3) {
                d.m = '三';
                d.v = '三';
            } else if (rsd === 4) {
                d.m = '四';
                d.v = '四';
            } else if (rsd === 5) {
                d.m = '五';
                d.v = '五';
            } else if (rsd === 6) {
                d.m = '六';
                d.v = '六';
            }

            applyData.push(d);
        }
    }

    return applyData;
}

function fillChnWeek2(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);

        let num: number;
        const m = data[data.length - 1]?.m;
        if (m != null && d != null) {
            if (m === '周日') {
                num = 7 + step * i;
            } else {
                const last = `${m}`;
                const txt = last.slice(last.length - 1, 1);
                num = chineseToNumber(txt) + step * i;
            }

            if (num < 0) {
                num = Math.ceil(Math.abs(num) / 7) * 7 + num;
            }

            const rsd = num % 7;
            if (rsd === 0) {
                d.m = '周日';
                d.v = '周日';
            } else if (rsd === 1) {
                d.m = '周一';
                d.v = '周一';
            } else if (rsd === 2) {
                d.m = '周二';
                d.v = '周二';
            } else if (rsd === 3) {
                d.m = '周三';
                d.v = '周三';
            } else if (rsd === 4) {
                d.m = '周四';
                d.v = '周四';
            } else if (rsd === 5) {
                d.m = '周五';
                d.v = '周五';
            } else if (rsd === 6) {
                d.m = '周六';
                d.v = '周六';
            }
        }

        applyData.push(d);
    }

    return applyData;
}

function fillChnWeek3(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);

        let num: number;
        const m = data[data.length - 1]?.m;
        if (m != null && d != null) {
            if (m === '星期日') {
                num = 7 + step * i;
            } else {
                const last = `${m}`;
                const txt = last.slice(last.length - 1, 1);
                num = chineseToNumber(txt) + step * i;
            }

            if (num < 0) {
                num = Math.ceil(Math.abs(num) / 7) * 7 + num;
            }

            const rsd = num % 7;
            if (rsd === 0) {
                d.m = '星期日';
                d.v = '星期日';
            } else if (rsd === 1) {
                d.m = '星期一';
                d.v = '星期一';
            } else if (rsd === 2) {
                d.m = '星期二';
                d.v = '星期二';
            } else if (rsd === 3) {
                d.m = '星期三';
                d.v = '星期三';
            } else if (rsd === 4) {
                d.m = '星期四';
                d.v = '星期四';
            } else if (rsd === 5) {
                d.m = '星期五';
                d.v = '星期五';
            } else if (rsd === 6) {
                d.m = '星期六';
                d.v = '星期六';
            }
        }

        applyData.push(d);
    }

    return applyData;
}

function fillChnNumber(data: (Cell | null | undefined)[], len: number, step: number) {
    const applyData = [];

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);

        const m = data[data.length - 1]?.m;
        if (m != null && d != null) {
            const num = chineseToNumber(`${m}`) + step * i;
            const txt = num <= 0 ? '零' : numberToChinese(num);

            d.v = txt;
            d.m = txt.toString();
            applyData.push(d);
        }
    }

    return applyData;
}

// Advance `base` by `n` units, then, if it lands on a weekend, roll back to the
// nearest weekday (Sunday → Friday, Saturday → Friday). Used by every "fill by
// weekdays" branch, which each inlined this motif.
function rollToWeekday(base: dayjs.ConfigType, n: number, unit: dayjs.ManipulateType) {
    const moved = dayjs(base).add(n, unit);
    const day = moved.day();

    if (day === 0) {
        return moved.subtract(2, 'days').format('YYYY-MM-DD');
    }
    if (day === 6) {
        return moved.subtract(1, 'days').format('YYYY-MM-DD');
    }
    return moved.format('YYYY-MM-DD');
}

// Date-fill series: the step is derived once per cycle (from the first element,
// expressed in days); rollWeekend additionally rolls produced dates back off
// the weekend ("fill by weekdays" vs the plain month/year branches).
function fillDateSeries(
    data: (Cell | null | undefined)[],
    len: number,
    stepAmount: number,
    stepUnit: dayjs.ManipulateType,
    rollWeekend: boolean,
) {
    const applyData: Cell[] = [];
    let step: number;

    for (let i = 1; i <= len; i += 1) {
        const index = (i - 1) % data.length;
        const d = cloneDeep(data[index]);
        if (d != null) {
            const num = Math.ceil(i / data.length);
            if (index === 0) {
                step = dayjs(d.m)
                    .add(stepAmount * num, stepUnit)
                    .diff(dayjs(d.m), 'days');
            }

            const date = rollWeekend
                ? rollToWeekday(d.m, step!, 'days')
                : dayjs(d.m).add(step!, 'days').format('YYYY-MM-DD');
            d.m = date;
            d.v = genarate(date)[2];
            applyData.push(d);
        }
    }

    return applyData;
}

// Chinese-weekday producers (周一~周日 / 星期一~星期日) — identical apart from the
// "Sunday" sentinel and which producer emits the filled cells.
function fillChnWeekType(
    data: (Cell | null | undefined)[],
    len: number,
    direction: string,
    sundayText: string,
    fill: (data: (Cell | null | undefined)[], len: number, step: number) => (Cell | null | undefined)[],
) {
    const dataNumArr = [];
    let weekIndex = 0;

    for (let i = 0; i < data.length; i += 1) {
        let m = data[i]?.m;
        if (m != null) {
            m = `${m}`;
            const lastTxt = m.slice(m.length - 1, 1);
            if (m === sundayText) {
                if (i === 0) {
                    dataNumArr.push(0);
                } else {
                    weekIndex += 1;
                    dataNumArr.push(weekIndex * 7);
                }
            } else {
                dataNumArr.push(chineseToNumber(lastTxt) + weekIndex * 7);
            }
        }
    }

    if (direction === 'up' || direction === 'left') {
        data.reverse();
        dataNumArr.reverse();
    }

    if (isEqualDiff(dataNumArr)) {
        const step = dataNumArr[1] - dataNumArr[0];
        return fill(data, len, step);
    }

    return fillCopy(data, len);
}

export function getTypeItemHide(ctx: Context) {
    const { copyRange } = dropCellCache;
    const str_r = copyRange.row[0];
    const end_r = copyRange.row[1];
    const str_c = copyRange.column[0];
    const end_c = copyRange.column[1];

    let hasNumber = false;
    let hasExtendNumber = false;
    let hasDate = false;
    let hasChn = false;
    let hasChnWeek1 = false;
    let hasChnWeek2 = false;
    let hasChnWeek3 = false;

    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return [];

    for (let r = str_r; r <= end_r; r += 1) {
        for (let c = str_c; c <= end_c; c += 1) {
            if (flowdata[r][c]) {
                const cell = flowdata[r][c];

                if (cell !== null && cell.v != null && cell.f == null) {
                    if (cell.ct != null && cell.ct.t === 'n') {
                        hasNumber = true;
                    } else if (cell.ct != null && cell.ct.t === 'd') {
                        hasDate = true;
                    } else if (isExtendNumber(cell.m)[0]) {
                        hasExtendNumber = true;
                    } else if (isChnNumber(cell.m) && cell.m !== '日') {
                        hasChn = true;
                    } else if (cell.m != null && cell.m === '日') {
                        hasChnWeek1 = true;
                    } else if (isChnWeek2(cell.m)) {
                        hasChnWeek2 = true;
                    } else if (isChnWeek3(cell.m)) {
                        hasChnWeek3 = true;
                    }
                }
            }
        }
    }

    return [hasNumber, hasExtendNumber, hasDate, hasChn, hasChnWeek1, hasChnWeek2, hasChnWeek3];
}

function getLenS(indexArr: number[], rsd: number) {
    let s = 0;

    for (let j = 0; j < indexArr.length; j += 1) {
        if (indexArr[j] <= rsd) {
            s += 1;
        } else {
            break;
        }
    }

    return s;
}

function getDataIndex(csLen: number, asLen: number, indexArr: number[]) {
    const obj: Record<string, number> = {};

    const num = Math.floor(asLen / csLen);
    const rsd = asLen % csLen;

    let sum = 0;
    if (num > 0) {
        for (let i = 1; i <= num; i += 1) {
            for (let j = 0; j < indexArr.length; j += 1) {
                obj[indexArr[j] + (i - 1) * csLen] = sum;
                sum += 1;
            }
        }
        for (let a = 0; a < indexArr.length; a += 1) {
            if (indexArr[a] <= rsd) {
                obj[indexArr[a] + csLen * num] = sum;
                sum += 1;
            } else {
                break;
            }
        }
    } else {
        for (let a = 0; a < indexArr.length; a += 1) {
            if (indexArr[a] <= rsd) {
                obj[indexArr[a]] = sum;
                sum += 1;
            } else {
                break;
            }
        }
    }

    return obj;
}

function getDataByType(
    data: (Cell | null | undefined)[],
    len: number,
    direction: string,
    type: string,
    dataType?: string,
) {
    data = cloneDeep(data);
    let applyData: (Cell | null | undefined)[] = [];

    if (type === '0' || data.length === 1) {
        // copy cells
        if (direction === 'up' || direction === 'left') {
            data.reverse();
        }

        applyData = fillCopy(data, len);
    } else if (type === '1') {
        // fill series
        if (dataType === 'number') {
            // data type: number
            applyData = fillSeries(data, len, direction);
        } else if (dataType === 'extendNumber') {
            // extended number
            const dataNumArr = [];

            for (let i = 0; i < data.length; i += 1) {
                const txt = data[i]?.m;
                const _isExtendNumber = isExtendNumber(txt);
                if (_isExtendNumber[0]) {
                    dataNumArr.push(_isExtendNumber[1] as number);
                }
            }

            if (direction === 'up' || direction === 'left') {
                data.reverse();
                dataNumArr.reverse();
            }

            if (isEqualDiff(dataNumArr)) {
                // arithmetic sequence — use the common difference as step
                const step = dataNumArr[1] - dataNumArr[0];
                applyData = fillExtendNumber(data, len, step);
            } else {
                // not an arithmetic sequence — copy data
                applyData = fillCopy(data, len);
            }
        } else if (dataType === 'date') {
            // data type: date
            if (direction === 'up' || direction === 'left') {
                data.reverse();
            }

            const _judgeDate = judgeDate(data);
            if (_judgeDate[0] && _judgeDate[3]) {
                // same day, month difference is an arithmetic sequence — use month diff as step
                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');
                applyData = fillMonths(data, len, step);
            } else if (!_judgeDate[0] && _judgeDate[2]) {
                // different day, day difference is an arithmetic sequence — use day diff as step
                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'days');
                applyData = fillDays(data, len, step);
            } else {
                // other — copy data
                applyData = fillCopy(data, len);
            }
        } else if (dataType === 'chnNumber' && data[0]?.m != null) {
            // data type: Chinese lowercase numbers

            let hasweek = false;
            for (let i = 0; i < data.length; i += 1) {
                if (data[i]?.m === '日') {
                    hasweek = true;
                    break;
                }
            }

            const dataNumArr = [];
            let weekIndex = 0;
            for (let i = 0; i < data.length; i += 1) {
                let m = data[i]?.m;
                if (m != null) {
                    m = `${m}`;
                    if (m === '日') {
                        if (i === 0) {
                            dataNumArr.push(0);
                        } else {
                            weekIndex += 1;
                            dataNumArr.push(weekIndex * 7);
                        }
                    } else if (hasweek && chineseToNumber(m) > 0 && chineseToNumber(m) < 7) {
                        dataNumArr.push(chineseToNumber(m) + weekIndex * 7);
                    } else {
                        dataNumArr.push(chineseToNumber(m));
                    }
                }
            }

            if (direction === 'up' || direction === 'left') {
                data.reverse();
                dataNumArr.reverse();
            }

            if (isEqualDiff(dataNumArr)) {
                if (
                    hasweek ||
                    (dataNumArr[dataNumArr.length - 1] < 6 && dataNumArr[0] > 0) ||
                    (dataNumArr[0] < 6 && dataNumArr[dataNumArr.length - 1] > 0)
                ) {
                    // fill with Mon–Sun sequence
                    const step = dataNumArr[1] - dataNumArr[0];
                    applyData = fillChnWeek(data, len, step);
                } else {
                    // fill with Chinese lowercase number sequence
                    const step = dataNumArr[1] - dataNumArr[0];
                    applyData = fillChnNumber(data, len, step);
                }
            } else {
                // not an arithmetic sequence — copy data
                applyData = fillCopy(data, len);
            }
        } else if (dataType === 'chnWeek2') {
            // Mon (周一) ~ Sun (周日)
            applyData = fillChnWeekType(data, len, direction, '周日', fillChnWeek2);
        } else if (dataType === 'chnWeek3') {
            // Monday (星期一) ~ Sunday (星期日)
            applyData = fillChnWeekType(data, len, direction, '星期日', fillChnWeek3);
        } else {
            // data type: other
            if (direction === 'up' || direction === 'left') {
                data.reverse();
            }

            applyData = fillCopy(data, len);
        }
    } else if (type === '4') {
        // fill by days
        if (data.length === 2) {
            // use the day difference as step
            if (direction === 'up' || direction === 'left') {
                data.reverse();
            }

            const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'days');
            applyData = fillDays(data, len, step);
        } else {
            if (direction === 'up' || direction === 'left') {
                data.reverse();
            }

            const _judgeDate = judgeDate(data);
            if (_judgeDate[0] && _judgeDate[3]) {
                // same day, month difference is an arithmetic sequence — use month diff as step
                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');
                applyData = fillMonths(data, len, step);
            } else if (!_judgeDate[0] && _judgeDate[2]) {
                // different day, day difference is an arithmetic sequence — use day diff as step
                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'days');
                applyData = fillDays(data, len, step);
            } else {
                // day difference is not an arithmetic sequence — copy data
                applyData = fillCopy(data, len);
            }
        }
    } else if (type === '5') {
        // fill by weekdays
        if (data.length === 2) {
            if (
                dayjs(data[1]?.m).date() === dayjs(data[0]?.m).date() &&
                dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months') !== 0
            ) {
                // same day, month diff > 1 month — use month diff as step (if that day is a weekend, roll back to nearest weekday)
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');

                for (let i = 1; i <= len; i += 1) {
                    const index = (i - 1) % data.length;
                    const d = cloneDeep(data[index]);
                    const last = data[data.length - 1]?.m;
                    if (d != null && last != null) {
                        const date = rollToWeekday(last, step * i, 'months');
                        d.m = date;
                        d.v = genarate(date)[2];
                        applyData.push(d);
                    }
                }
            } else {
                // different day
                if (Math.abs(dayjs(data[1]?.m).diff(dayjs(data[0]?.m))) > 7) {
                    // day diff > 7 days — use 1 month as step (if that day is a weekend, roll back to nearest weekday)
                    if (direction === 'down' || direction === 'right') {
                        applyData = fillDateSeries(data, len, 1, 'months', true);
                    } else {
                        data.reverse();
                        applyData = fillDateSeries(data, len, -1, 'months', true);
                    }
                } else {
                    // day diff <= 7 days — use 7 days as step (if that day is a weekend, roll back to nearest weekday)
                    if (direction === 'down' || direction === 'right') {
                        applyData = fillDateSeries(data, len, 7, 'days', true);
                    } else {
                        data.reverse();
                        applyData = fillDateSeries(data, len, -7, 'days', true);
                    }
                }
            }
        } else {
            const _judgeDate = judgeDate(data);
            if (_judgeDate[0] && _judgeDate[3]) {
                // same day, month diff is an arithmetic sequence — use month diff as step (if that day is a weekend, roll back to nearest weekday)
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');

                for (let i = 1; i <= len; i += 1) {
                    const index = (i - 1) % data.length;
                    const d = cloneDeep(data[index]);
                    const last = data[data.length - 1]?.m;
                    if (d != null) {
                        const date = rollToWeekday(last, step * i, 'months');
                        d.m = date;
                        d.v = genarate(date)[2];
                        applyData.push(d);
                    }
                }
            } else if (!_judgeDate[0] && _judgeDate[2]) {
                // different day, day difference is an arithmetic sequence
                if (Math.abs(dayjs(data[1]?.m).diff(dayjs(data[0]?.m))) > 7) {
                    // day diff > 7 days — use 1 month as step (if that day is a weekend, roll back to nearest weekday)
                    if (direction === 'down' || direction === 'right') {
                        applyData = fillDateSeries(data, len, 1, 'months', true);
                    } else {
                        data.reverse();
                        applyData = fillDateSeries(data, len, -1, 'months', true);
                    }
                } else {
                    // day diff <= 7 days — use 7 days as step (if that day is a weekend, roll back to nearest weekday)
                    if (direction === 'down' || direction === 'right') {
                        applyData = fillDateSeries(data, len, 7, 'days', true);
                    } else {
                        data.reverse();
                        applyData = fillDateSeries(data, len, -7, 'days', true);
                    }
                }
            } else {
                // day difference is not an arithmetic sequence — copy data
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                applyData = fillCopy(data, len);
            }
        }
    } else if (type === '6') {
        // fill by months
        if (data.length === 2) {
            if (
                dayjs(data[1]?.m).date() === dayjs(data[0]?.m).date() &&
                dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months') !== 0
            ) {
                // same day, month diff > 1 month — use month diff as step
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');
                applyData = fillMonths(data, len, step);
            } else {
                // use 1 month as step
                if (direction === 'down' || direction === 'right') {
                    applyData = fillDateSeries(data, len, 1, 'months', false);
                } else {
                    data.reverse();
                    applyData = fillDateSeries(data, len, -1, 'months', false);
                }
            }
        } else {
            const _judgeDate = judgeDate(data);
            if (_judgeDate[0] && _judgeDate[3]) {
                // same day, month difference is an arithmetic sequence — use month diff as step
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'months');
                applyData = fillMonths(data, len, step);
            } else if (!_judgeDate[0] && _judgeDate[2]) {
                // different day, day difference is an arithmetic sequence — use 1 month as step
                if (direction === 'down' || direction === 'right') {
                    applyData = fillDateSeries(data, len, 1, 'months', false);
                } else {
                    data.reverse();
                    applyData = fillDateSeries(data, len, -1, 'months', false);
                }
            } else {
                // day difference is not an arithmetic sequence — copy data
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                applyData = fillCopy(data, len);
            }
        }
    } else if (type === '7') {
        // fill by years
        if (data.length === 2) {
            if (
                dayjs(data[1]?.m).date() === dayjs(data[0]?.m).date() &&
                dayjs(data[1]?.m).month() === dayjs(data[0]?.m).month() &&
                dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'years') !== 0
            ) {
                // same day and month, year diff > 1 year — use year diff as step
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'years');
                applyData = fillYears(data, len, step);
            } else {
                // use 1 year as step
                if (direction === 'down' || direction === 'right') {
                    applyData = fillDateSeries(data, len, 1, 'years', false);
                } else {
                    data.reverse();
                    applyData = fillDateSeries(data, len, -1, 'years', false);
                }
            }
        } else {
            const _judgeDate = judgeDate(data);
            if (_judgeDate[0] && _judgeDate[1] && _judgeDate[4]) {
                // same day and month, year difference is an arithmetic sequence — use year diff as step
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                const step = dayjs(data[1]?.m).diff(dayjs(data[0]?.m), 'years');
                applyData = fillYears(data, len, step);
            } else if ((_judgeDate[0] && _judgeDate[3]) || _judgeDate[2]) {
                // same day with arithmetic month diff, or arithmetic day diff — use 1 year as step
                if (direction === 'down' || direction === 'right') {
                    applyData = fillDateSeries(data, len, 1, 'years', false);
                } else {
                    data.reverse();
                    applyData = fillDateSeries(data, len, -1, 'years', false);
                }
            } else {
                // day difference is not an arithmetic sequence — copy data
                if (direction === 'up' || direction === 'left') {
                    data.reverse();
                }

                applyData = fillCopy(data, len);
            }
        }
    } else if (type === '8') {
        // fill with Chinese lowercase number sequence
        const dataNumArr = [];
        for (let i = 0; i < data.length; i += 1) {
            let m = data[i]?.m;
            if (m != null) {
                m = `${m}`;
                dataNumArr.push(chineseToNumber(m));
            }
        }

        if (direction === 'up' || direction === 'left') {
            data.reverse();
            dataNumArr.reverse();
        }

        if (isEqualDiff(dataNumArr)) {
            const step = dataNumArr[1] - dataNumArr[0];
            applyData = fillChnNumber(data, len, step);
        } else {
            // not an arithmetic sequence — copy data
            applyData = fillCopy(data, len);
        }
    }

    return applyData;
}

function getCopyData(d: CellMatrix, r1: number, r2: number, c1: number, c2: number, direction: string) {
    const copyData = [];

    let a1: number;
    let a2: number;
    let b1: number;
    let b2: number;
    if (direction === 'down' || direction === 'up') {
        a1 = c1;
        a2 = c2;
        b1 = r1;
        b2 = r2;
    } else {
        a1 = r1;
        a2 = r2;
        b1 = c1;
        b2 = c2;
    }

    for (let a = a1; a <= a2; a += 1) {
        const obj: Record<string, { data: (Cell | null | undefined)[]; index: number[] }[]> = {};

        let arrData = [];
        let arrIndex = [];
        let text = '';
        let extendNumberBeforeStr = null;
        let extendNumberAfterStr = null;
        let isSameStr = true;

        for (let b: number = b1; b <= b2; b += 1) {
            // cell
            let data: Cell | null | undefined;
            if (direction === 'down' || direction === 'up') {
                data = d[b][a];
            } else if (direction === 'right' || direction === 'left') {
                data = d[a][b];
            }

            // cell value type
            let str: string;
            if (data?.v != null && data.f == null) {
                if (data.ct && data.ct.t === 'n') {
                    str = 'number';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                } else if (data.ct && data.ct.t === 'd') {
                    str = 'date';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                } else if (isExtendNumber(data.m)[0]) {
                    str = 'extendNumber';

                    const _isExtendNumber = isExtendNumber(data.m);

                    if (extendNumberBeforeStr == null || extendNumberAfterStr == null) {
                        isSameStr = true;
                        [, , extendNumberBeforeStr, extendNumberAfterStr] = _isExtendNumber;
                    } else {
                        if (
                            _isExtendNumber[2] !== extendNumberBeforeStr ||
                            _isExtendNumber[3] !== extendNumberAfterStr
                        ) {
                            isSameStr = false;
                            [, , extendNumberBeforeStr, extendNumberAfterStr] = _isExtendNumber;
                        } else {
                            isSameStr = true;
                        }
                    }
                } else if (isChnNumber(data.m)) {
                    str = 'chnNumber';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                } else if (isChnWeek2(data.m)) {
                    str = 'chnWeek2';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                } else if (isChnWeek3(data.m)) {
                    str = 'chnWeek3';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                } else {
                    str = 'other';
                    extendNumberBeforeStr = null;
                    extendNumberAfterStr = null;
                }
            } else {
                str = 'other';
                extendNumberBeforeStr = null;
                extendNumberAfterStr = null;
            }

            if (str === 'extendNumber') {
                if (b === b1) {
                    if (b1 === b2) {
                        text = str;
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);

                        obj[text] = [];
                        obj[text].push({ data: arrData, index: arrIndex });
                    } else {
                        text = str;
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);
                    }
                } else if (b === b2) {
                    if (text === str && isSameStr) {
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);

                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }
                    } else {
                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }

                        text = str;
                        arrData = [];
                        arrData.push(data);
                        arrIndex = [];
                        arrIndex.push(b - b1 + 1);

                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }
                    }
                } else {
                    if (text === str && isSameStr) {
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);
                    } else {
                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }

                        text = str;
                        arrData = [];
                        arrData.push(data);
                        arrIndex = [];
                        arrIndex.push(b - b1 + 1);
                    }
                }
            } else {
                if (b === b1) {
                    if (b1 === b2) {
                        text = str;
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);

                        obj[text] = [];
                        obj[text].push({ data: arrData, index: arrIndex });
                    } else {
                        text = str;
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);
                    }
                } else if (b === b2) {
                    if (text === str) {
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);

                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }
                    } else {
                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }

                        text = str;
                        arrData = [];
                        arrData.push(data);
                        arrIndex = [];
                        arrIndex.push(b - b1 + 1);

                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }
                    }
                } else {
                    if (text === str) {
                        arrData.push(data);
                        arrIndex.push(b - b1 + 1);
                    } else {
                        if (text in obj) {
                            obj[text].push({ data: arrData, index: arrIndex });
                        } else {
                            obj[text] = [];
                            obj[text].push({ data: arrData, index: arrIndex });
                        }

                        text = str;
                        arrData = [];
                        arrData.push(data);
                        arrIndex = [];
                        arrIndex.push(b - b1 + 1);
                    }
                }
            }
        }

        copyData.push(obj);
    }

    return copyData;
}

function getApplyData(
    copyD: Record<
        string,
        {
            data: (Cell | null | undefined)[];
            index: number[];
        }[]
    >,
    csLen: number,
    asLen: number,
) {
    const applyData = [];

    // direction + applyType are seeded by onDropCellSelectEnd / autoFillCell
    // before updateDropCell calls into this function. Cache nulls are only
    // possible at module init, never on a real fill.
    const direction = dropCellCache.direction ?? 'down';
    const type = dropCellCache.applyType ?? '0';

    const num = Math.floor(asLen / csLen);
    const rsd = asLen % csLen;

    // pure number type
    const copyD_number = copyD.number;
    const applyD_number = [];
    if (copyD_number) {
        for (let i = 0; i < copyD_number.length; i += 1) {
            const s = getLenS(copyD_number[i].index, rsd);
            const len = copyD_number[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_number[i].data, len, direction, type, 'number');
            } else if (type === '2') {
                arrData = getDataByType(copyD_number[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_number[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_number[i].index);
            applyD_number.push({ data: arrData, index: arrIndex });
        }
    }

    // extended number type (a string ending with a number)
    const copyD_extendNumber = copyD.extendNumber;
    const applyD_extendNumber = [];
    if (copyD_extendNumber) {
        for (let i = 0; i < copyD_extendNumber.length; i += 1) {
            const s = getLenS(copyD_extendNumber[i].index, rsd);
            const len = copyD_extendNumber[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_extendNumber[i].data, len, direction, type, 'extendNumber');
            } else if (type === '2') {
                arrData = getDataByType(copyD_extendNumber[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_extendNumber[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_extendNumber[i].index);
            applyD_extendNumber.push({ data: arrData, index: arrIndex });
        }
    }

    // date type
    const copyD_date = copyD.date;
    const applyD_date = [];
    if (copyD_date) {
        for (let i = 0; i < copyD_date.length; i += 1) {
            const s = getLenS(copyD_date[i].index, rsd);
            const len = copyD_date[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_date[i].data, len, direction, type, 'date');
            } else if (type === '8') {
                arrData = getDataByType(copyD_date[i].data, len, direction, '0');
            } else {
                arrData = getDataByType(copyD_date[i].data, len, direction, type);
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_date[i].index);
            applyD_date.push({ data: arrData, index: arrIndex });
        }
    }

    const copyD_chnNumber = copyD.chnNumber;
    const applyD_chnNumber = [];
    if (copyD_chnNumber) {
        for (let i = 0; i < copyD_chnNumber.length; i += 1) {
            const s = getLenS(copyD_chnNumber[i].index, rsd);
            const len = copyD_chnNumber[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_chnNumber[i].data, len, direction, type, 'chnNumber');
            } else if (type === '2' || type === '8') {
                arrData = getDataByType(copyD_chnNumber[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_chnNumber[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_chnNumber[i].index);
            applyD_chnNumber.push({ data: arrData, index: arrIndex });
        }
    }

    // Mon (周一) ~ Sun (周日)
    const copyD_chnWeek2 = copyD.chnWeek2;
    const applyD_chnWeek2 = [];
    if (copyD_chnWeek2) {
        for (let i = 0; i < copyD_chnWeek2.length; i += 1) {
            const s = getLenS(copyD_chnWeek2[i].index, rsd);
            const len = copyD_chnWeek2[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_chnWeek2[i].data, len, direction, type, 'chnWeek2');
            } else if (type === '2') {
                arrData = getDataByType(copyD_chnWeek2[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_chnWeek2[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_chnWeek2[i].index);
            applyD_chnWeek2.push({ data: arrData, index: arrIndex });
        }
    }

    // Monday (星期一) ~ Sunday (星期日)
    const copyD_chnWeek3 = copyD.chnWeek3;
    const applyD_chnWeek3 = [];
    if (copyD_chnWeek3) {
        for (let i = 0; i < copyD_chnWeek3.length; i += 1) {
            const s = getLenS(copyD_chnWeek3[i].index, rsd);
            const len = copyD_chnWeek3[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '1' || type === '3') {
                arrData = getDataByType(copyD_chnWeek3[i].data, len, direction, type, 'chnWeek3');
            } else if (type === '2') {
                arrData = getDataByType(copyD_chnWeek3[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_chnWeek3[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_chnWeek3[i].index);
            applyD_chnWeek3.push({ data: arrData, index: arrIndex });
        }
    }

    // other
    const copyD_other = copyD.other;
    const applyD_other = [];
    if (copyD_other) {
        for (let i = 0; i < copyD_other.length; i += 1) {
            const s = getLenS(copyD_other[i].index, rsd);
            const len = copyD_other[i].index.length * num + s;

            let arrData: (Cell | null | undefined)[];
            if (type === '2' || type === '3') {
                arrData = getDataByType(copyD_other[i].data, len, direction, type);
            } else {
                arrData = getDataByType(copyD_other[i].data, len, direction, '0');
            }

            const arrIndex = getDataIndex(csLen, asLen, copyD_other[i].index);
            applyD_other.push({ data: arrData, index: arrIndex });
        }
    }

    for (let x = 1; x <= asLen; x += 1) {
        if (applyD_number.length > 0) {
            for (let y = 0; y < applyD_number.length; y += 1) {
                if (x in applyD_number[y].index) {
                    applyData.push(applyD_number[y].data[applyD_number[y].index[x]]);
                }
            }
        }

        if (applyD_extendNumber.length > 0) {
            for (let y = 0; y < applyD_extendNumber.length; y += 1) {
                if (x in applyD_extendNumber[y].index) {
                    applyData.push(applyD_extendNumber[y].data[applyD_extendNumber[y].index[x]]);
                }
            }
        }

        if (applyD_date.length > 0) {
            for (let y = 0; y < applyD_date.length; y += 1) {
                if (x in applyD_date[y].index) {
                    applyData.push(applyD_date[y].data[applyD_date[y].index[x]]);
                }
            }
        }

        if (applyD_chnNumber.length > 0) {
            for (let y = 0; y < applyD_chnNumber.length; y += 1) {
                if (x in applyD_chnNumber[y].index) {
                    applyData.push(applyD_chnNumber[y].data[applyD_chnNumber[y].index[x]]);
                }
            }
        }

        if (applyD_chnWeek2.length > 0) {
            for (let y = 0; y < applyD_chnWeek2.length; y += 1) {
                if (x in applyD_chnWeek2[y].index) {
                    applyData.push(applyD_chnWeek2[y].data[applyD_chnWeek2[y].index[x]]);
                }
            }
        }

        if (applyD_chnWeek3.length > 0) {
            for (let y = 0; y < applyD_chnWeek3.length; y += 1) {
                if (x in applyD_chnWeek3[y].index) {
                    applyData.push(applyD_chnWeek3[y].data[applyD_chnWeek3[y].index[x]]);
                }
            }
        }

        if (applyD_other.length > 0) {
            for (let y = 0; y < applyD_other.length; y += 1) {
                if (x in applyD_other[y].index) {
                    applyData.push(applyD_other[y].data[applyD_other[y].index[x]]);
                }
            }
        }
    }

    return applyData;
}

export function updateDropCell(ctx: Context) {
    const d = getFlowdata(ctx);
    const allowEdit = isAllowEdit(ctx);
    if (allowEdit === false || d == null) {
        return;
    }

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];
    const hiddenRows = new Set(Object.keys(file.config?.rowhidden || {}));
    const hiddenCols = new Set(Object.keys(file.config?.colhidden || {}));

    // Live resolver, hoisted: one per fill-drag instead of one snapshot per
    // filled formula cell.
    const resolver = createContextResolver(ctx);

    const cfg = (file.config ??= {});
    const borderInfoCompute = getBorderInfoCompute(ctx, ctx.currentSheetId);
    // Live map, not a clone: the copy and apply ranges are disjoint, so reading a source
    // rule while writing the filled ones is safe — and the write has to land on the sheet
    // to sync and undo (Excel and Google both carry validation on a fill).
    const { dataVerification } = file;

    // direction is seeded by onDropCellSelectEnd / autoFillCell before they call
    // updateDropCell; the null fallback only matters for module-init safety.
    const direction = dropCellCache.direction ?? 'down';

    // copy range
    const { copyRange } = dropCellCache;
    const copy_str_r = copyRange.row[0];
    const copy_end_r = copyRange.row[1];
    const copy_str_c = copyRange.column[0];
    const copy_end_c = copyRange.column[1];
    const copyData = getCopyData(d, copy_str_r, copy_end_r, copy_str_c, copy_end_c, direction);

    const csLen =
        direction === 'down' || direction === 'up' ? copy_end_r - copy_str_r + 1 : copy_end_c - copy_str_c + 1;

    // apply range
    const { applyRange } = dropCellCache;
    const apply_str_r = applyRange.row[0];
    const apply_end_r = applyRange.row[1];
    const apply_str_c = applyRange.column[0];
    const apply_end_c = applyRange.column[1];

    // The four drag directions differ only in axis (rows for down/up, columns
    // for right/left) and sign (up/left iterate the applied range in reverse);
    // number-format handling is identical across all four.
    const axisIsRow = direction === 'down' || direction === 'up';
    const reverse = direction === 'up' || direction === 'left';

    const asLen = axisIsRow ? apply_end_r - apply_str_r + 1 : apply_end_c - apply_str_c + 1;
    const outerStart = axisIsRow ? apply_str_c : apply_str_r;
    const outerEnd = axisIsRow ? apply_end_c : apply_end_r;
    const outerHidden = axisIsRow ? hiddenCols : hiddenRows;
    const innerStart = axisIsRow ? apply_str_r : apply_str_c;
    const innerEnd = axisIsRow ? apply_end_r : apply_end_c;
    const innerHidden = axisIsRow ? hiddenRows : hiddenCols;
    const copyStartAxis = axisIsRow ? copy_str_r : copy_str_c;
    const copyEndAxis = axisIsRow ? copy_end_r : copy_end_c;

    for (let outer = outerStart; outer <= outerEnd; outer += 1) {
        if (outerHidden.has(`${outer}`)) continue;
        const copyD = copyData[outer - outerStart];

        const applyData = getApplyData(copyD, csLen, asLen);

        const innerCount = innerEnd - innerStart + 1;
        for (let step = 0; step < innerCount; step += 1) {
            const pos = reverse ? innerEnd - step : innerStart + step;
            if (innerHidden.has(`${pos}`)) continue;

            const row = axisIsRow ? pos : outer;
            const col = axisIsRow ? outer : pos;
            const cell = applyData[step];

            if (cell?.f != null) {
                const f = `=${functionCopy(cell.f, direction, step + 1)}`;
                const v = execfunction(ctx, f, row, col, undefined, undefined, undefined, undefined, resolver);

                execFunctionGroup(ctx, row, col, v[1], undefined, d);

                [, cell.v, cell.f] = v;

                if (cell.v != null) {
                    if (
                        isRealNum(cell.v) &&
                        !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(`${cell.v}`)
                    ) {
                        if (cell.v === Infinity || cell.v === -Infinity) {
                            cell.m = cell.v.toString();
                        } else if (cell.v.toString().indexOf('e') > -1) {
                            let len = cell.v.toString().split('.')[1].split('e')[0].length;
                            if (len > 5) {
                                len = 5;
                            }

                            cell.m = (cell.v as number).toExponential(len).toString();
                        } else {
                            const rounded = Math.round((cell.v as number) * 1000000000) / 1000000000;
                            // Keep an existing number format (Excel/Google parity):
                            // render through its mask rather than auto-detecting one.
                            cell.m =
                                cell.ct?.fa != null && cell.ct.fa !== 'General'
                                    ? update(cell.ct.fa, rounded)
                                    : genarate(rounded)[0].toString();
                        }

                        cell.ct = cell.ct || { fa: 'General', t: 'n' };
                    } else {
                        const mask = genarate(cell.v);
                        cell.m = mask[0].toString();
                        [, cell.ct] = mask;
                    }
                }
            }

            d[row][col] = cell || null;

            // border: map the applied cell back to the source cell it was cloned
            // from (modulo the copy-block length) to carry its border over.
            const bd_axis = reverse ? copyEndAxis - (step % csLen) : copyStartAxis + (step % csLen);
            const bd_r = axisIsRow ? bd_axis : outer;
            const bd_c = axisIsRow ? outer : bd_axis;

            const computeEntry = borderInfoCompute[`${bd_r}_${bd_c}`];
            if (computeEntry) {
                const bd_obj: CellBorderInfo = {
                    rangeType: 'cell',
                    value: {
                        row_index: row,
                        col_index: col,
                        l: computeEntry.l,
                        r: computeEntry.r,
                        t: computeEntry.t,
                        b: computeEntry.b,
                    },
                };

                (cfg.borderInfo ??= []).push(bd_obj);
            } else if (borderInfoCompute[`${row}_${col}`]) {
                const bd_obj: CellBorderInfo = {
                    rangeType: 'cell',
                    value: {
                        row_index: row,
                        col_index: col,
                        l: null,
                        r: null,
                        t: null,
                        b: null,
                    },
                };

                (cfg.borderInfo ??= []).push(bd_obj);
            }

            // data validation
            if (dataVerification?.[`${bd_r}_${bd_c}`]) {
                dataVerification[`${row}_${col}`] = dataVerification[`${bd_r}_${bd_c}`];
            }
        }
    }

    // conditional format
    const cdformat = file.conditionalFormatRules;
    if (cdformat != null && cdformat.length > 0) {
        for (let i = 0; i < cdformat.length; i += 1) {
            const cdformat_cellrange = cdformat[i].cellrange;

            const emptyRange: SingleRange[] = [];

            for (let j = 0; j < cdformat_cellrange.length; j += 1) {
                emptyRange.push(
                    ...cfSplitRange(
                        cdformat_cellrange[j],
                        { row: copyRange.row, column: copyRange.column },
                        { row: applyRange.row, column: applyRange.column },
                        'operatePart',
                    ),
                );
            }

            if (emptyRange.length > 0) {
                cdformat[i].cellrange.push(applyRange);
            }
        }
    }

    // refresh the grid
    jfrefreshgrid(ctx, d, ctx.selections);
}

export function onDropCellSelectEnd(ctx: Context, e: MouseEvent, container: HTMLDivElement) {
    ctx.cellSelectExtending = false;
    hideDropCellSelection(container);

    const { scrollLeft, scrollTop } = ctx;
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop;

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row_pre = row_location[0];
    const row_index = row_location[2];
    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col_pre = col_location[0];
    const col_index = col_location[2];

    const row_index_original = ctx.cellSelectExtendIndex[0];
    const col_index_original = ctx.cellSelectExtendIndex[1];

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (
        last &&
        last.top != null &&
        last.left != null &&
        last.height != null &&
        last.width != null &&
        last.row_focus != null &&
        last.column_focus != null
    ) {
        let row_s = last.row[0];
        let row_e = last.row[1];
        let col_s = last.column[0];
        let col_e = last.column[1];

        // copy range
        dropCellCache.copyRange = cloneDeep(pick(last, ['row', 'column']));
        // applyType
        const typeItemHide = getTypeItemHide(ctx);

        if (
            !typeItemHide[0] &&
            !typeItemHide[1] &&
            !typeItemHide[2] &&
            !typeItemHide[3] &&
            !typeItemHide[4] &&
            !typeItemHide[5] &&
            !typeItemHide[6]
        ) {
            dropCellCache.applyType = '0';
        } else {
            dropCellCache.applyType = '1';
        }

        if (ctx.selections == null) return;
        const { top_move, left_move } = ctx.selections[0];
        if (Math.abs(row_index_original - row_index) > Math.abs(col_index_original - col_index)) {
            if (!(row_index >= row_s && row_index <= row_e)) {
                if (top_move != null && top_move >= row_pre) {
                    // dragging upward
                    dropCellCache.applyRange = {
                        row: [row_index, last.row[0] - 1],
                        column: last.column,
                    };
                    dropCellCache.direction = 'up';

                    row_s -= last.row[0] - row_index;
                } else {
                    // dragging downward
                    dropCellCache.applyRange = {
                        row: [last.row[1] + 1, row_index],
                        column: last.column,
                    };
                    dropCellCache.direction = 'down';

                    row_e += row_index - last.row[1];
                }
            } else {
                return;
            }
        } else {
            if (!(col_index >= col_s && col_index <= col_e)) {
                if (left_move != null && left_move >= col_pre) {
                    // dragging leftward
                    dropCellCache.applyRange = {
                        row: last.row,
                        column: [col_index, last.column[0] - 1],
                    };
                    dropCellCache.direction = 'left';

                    col_s -= last.column[0] - col_index;
                } else {
                    // dragging rightward
                    dropCellCache.applyRange = {
                        row: last.row,
                        column: [last.column[1] + 1, col_index],
                    };
                    dropCellCache.direction = 'right';

                    col_e += col_index - last.column[1];
                }
            } else {
                return;
            }
        }

        if (y < 0) {
            row_s = 0;
            [row_e] = last.row;
        }

        if (x < 0) {
            col_s = 0;
            [col_e] = last.column;
        }

        const flowdata = getFlowdata(ctx);
        if (flowdata == null) return;

        if (getSheetConfig(ctx)?.merge != null) {
            let HasMC = false;

            for (let r = last.row[0]; r <= last.row[1]; r += 1) {
                for (let c = last.column[0]; c <= last.column[1]; c += 1) {
                    const cell = flowdata[r]?.[c];

                    if (cell != null && cell.mc != null) {
                        HasMC = true;
                        break;
                    }
                }
            }

            if (HasMC) {
                return;
            }

            for (let r = row_s; r <= row_e; r += 1) {
                for (let c = col_s; c <= col_e; c += 1) {
                    const cell = flowdata[r]?.[c];

                    if (cell != null && cell.mc != null) {
                        HasMC = true;
                        break;
                    }
                }
            }

            if (HasMC) {
                return;
            }
        }

        last.row = [row_s, row_e];
        last.column = [col_s, col_e];

        ctx.selections = normalizeSelection(ctx, [
            {
                row: [row_s, row_e],
                column: [col_s, col_e],
            },
        ]);

        updateDropCell(ctx);

        for (const selectedMoveEle of container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-move')) {
            selectedMoveEle.style.display = 'none';
        }
    }
}
