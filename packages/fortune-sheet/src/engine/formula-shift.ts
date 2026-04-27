import { columnIndexToLabel, columnLabelToIndex } from './a1-notation';
import { iscelldata, operatorjson } from './formula-utils';
import { error } from './validation';

export type FormulaShiftMode = 'up' | 'down' | 'left' | 'right';

// Returns [rowAbsolute, colAbsolute] for a single ref like "$A$1" → [true, true].
// Exported so state-side `functionStrChange_range` can share the same detection.
export function detectAbsolute(txt: string): [boolean, boolean] {
    const row = txt.replace(/[^0-9]/g, '');
    const col = txt.replace(/[^A-Za-z]/g, '');
    return [
        row.length > 0 && txt.charAt(txt.indexOf(row) - 1) === '$',
        col.length > 0 && txt.charAt(txt.indexOf(col) - 1) === '$',
    ];
}

// Shift a single cell or range ref by `step` in `orient` direction
// ('d'/'u' = ±row, 'r'/'l' = ±col). $-prefixed parts stay put. Returns
// the original text if it isn't a recognizable ref, '#REF!' if a range
// endpoint shifts negative.
function shiftRef(orient: 'd' | 'u' | 'l' | 'r', txt: string, step: number): string {
    const sheetSplit = txt.split('!');
    let rangetxt: string;
    let prefix = '';
    if (sheetSplit.length > 1) {
        [, rangetxt] = sheetSplit;
        prefix = `${sheetSplit[0]}!`;
    } else {
        [rangetxt] = sheetSplit;
    }

    if (!rangetxt.includes(':')) {
        let row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10);
        let col = columnLabelToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));
        const [rowFrozen, colFrozen] = detectAbsolute(rangetxt);
        const $row = rowFrozen ? '$' : '';
        const $col = colFrozen ? '$' : '';

        if (orient === 'u' && !rowFrozen) row -= step;
        else if (orient === 'r' && !colFrozen) col += step;
        else if (orient === 'l' && !colFrozen) col -= step;
        else if (orient === 'd' && !rowFrozen) row += step;

        const rowValid = !Number.isNaN(row);
        const colValid = col >= 0;
        if (rowValid && colValid) return prefix + $col + columnIndexToLabel(col) + $row + row;
        if (rowValid) return prefix + $row + row;
        if (colValid) return prefix + $col + columnIndexToLabel(col);
        return txt;
    }

    const [startTxt, endTxt] = rangetxt.split(':');
    // Track presence per leg from the source string so column-only (`A:C`) and row-only
    // (`1:3`) ranges round-trip correctly. columnLabelToIndex('') returns -1 (a valid
    // sentinel for "missing"), but parseInt('') is NaN — we need a single source of truth
    // for both axes.
    const startRowStr = startTxt.replace(/[^0-9]/g, '');
    const endRowStr = endTxt.replace(/[^0-9]/g, '');
    const startColStr = startTxt.replace(/[^A-Za-z]/g, '');
    const endColStr = endTxt.replace(/[^A-Za-z]/g, '');
    const rowsMissing = startRowStr.length === 0 && endRowStr.length === 0;
    const colsMissing = startColStr.length === 0 && endColStr.length === 0;

    const row = [parseInt(startRowStr, 10), parseInt(endRowStr, 10)];
    if (!rowsMissing && row[0] > row[1]) return txt;

    const col = [columnLabelToIndex(startColStr), columnLabelToIndex(endColStr)];
    if (!colsMissing && col[0] > col[1]) return txt;

    const [row0Frozen, col0Frozen] = detectAbsolute(startTxt);
    const [row1Frozen, col1Frozen] = detectAbsolute(endTxt);
    const $row0 = row0Frozen ? '$' : '';
    const $col0 = col0Frozen ? '$' : '';
    const $row1 = row1Frozen ? '$' : '';
    const $col1 = col1Frozen ? '$' : '';

    if (orient === 'u') {
        if (!row0Frozen) row[0] -= step;
        if (!row1Frozen) row[1] -= step;
    } else if (orient === 'r') {
        if (!col0Frozen) col[0] += step;
        if (!col1Frozen) col[1] += step;
    } else if (orient === 'l') {
        if (!col0Frozen) col[0] -= step;
        if (!col1Frozen) col[1] -= step;
    } else if (orient === 'd') {
        if (!row0Frozen) row[0] += step;
        if (!row1Frozen) row[1] += step;
    }

    // For col-only ranges (`A:C`), col[0] starts at a valid 0+ index — only flag #REF!
    // when the axis was actually present and shifted negative.
    if ((!rowsMissing && row[0] < 0) || (!colsMissing && col[0] < 0)) return error['r'];

    if (colsMissing) return `${prefix + $row0 + row[0]}:${$row1}${row[1]}`;
    if (rowsMissing) return `${prefix + $col0 + columnIndexToLabel(col[0])}:${$col1}${columnIndexToLabel(col[1])}`;
    return `${prefix + $col0 + columnIndexToLabel(col[0]) + $row0 + row[0]}:${$col1}${columnIndexToLabel(col[1])}${$row1}${row[1]}`;
}

// Walks a formula string, finding cell-data refs and shifting them in the given
// direction. A leading `=` is stripped before processing; the returned text never
// carries one. Pure — no Context, no DOM. Negative `step` is allowed and reverses
// the direction. Used by:
//   - state/modules/conditionFormat.ts (CF formula rules)
//   - state/events/paste.ts (formula paste with relative refs)
//   - state/modules/sort.ts (sort moves formulas around)
//   - apps/api/src/lib/export/sheets/html.ts (server-side CF rule evaluation)
export function functionCopy(txt: string, mode: FormulaShiftMode = 'down', step = 1): string {
    let stripped = txt;
    if (stripped.startsWith('=')) stripped = stripped.slice(1);

    const orient = mode[0] as 'd' | 'u' | 'l' | 'r';
    const chars = stripped.split('');
    let i = 0;
    let str = '';
    let result = '';
    let dquote = 0;

    while (i < chars.length) {
        const s = chars[i];

        if (s === '(' && dquote === 0) {
            result += str.length > 0 ? `${str}(` : '(';
            str = '';
        } else if (s === ')' && dquote === 0) {
            result += `${functionCopy(str, mode, step)})`;
            str = '';
        } else if (s === '"') {
            if (dquote > 0) {
                result += `${str}"`;
                dquote -= 1;
                str = '';
            } else {
                dquote += 1;
                str += '"';
            }
        } else if (s === ',' && dquote === 0) {
            result += `${functionCopy(str, mode, step)},`;
            str = '';
        } else if (s === '&' && dquote === 0) {
            if (str.length > 0) {
                result += `${functionCopy(str, mode, step)}&`;
                str = '';
            } else {
                result += '&';
            }
        } else if (s in operatorjson && dquote === 0) {
            const sNext = i + 1 < chars.length ? chars[i + 1] : '';
            let p = i - 1;
            let sPre: string | null = null;
            if (p >= 0) {
                do {
                    sPre = chars[p];
                    p -= 1;
                } while (p >= 0 && sPre === ' ');
            }

            if (s + sNext in operatorjson) {
                if (str.length > 0) {
                    result += functionCopy(str, mode, step) + s + sNext;
                    str = '';
                } else {
                    result += s + sNext;
                }
                i += 1;
            } else if (
                !/[^0-9]/.test(sNext) &&
                s === '-' &&
                (sPre === '(' || sPre == null || sPre === ',' || sPre === ' ' || sPre in operatorjson)
            ) {
                str += s;
            } else if (str.length > 0) {
                result += functionCopy(str, mode, step) + s;
                str = '';
            } else {
                result += s;
            }
        } else {
            str += s;
        }

        if (i === chars.length - 1) {
            const trimmed = str.trim();
            result += iscelldata(trimmed) ? shiftRef(orient, trimmed, step) : trimmed;
        }

        i += 1;
    }

    return result;
}
