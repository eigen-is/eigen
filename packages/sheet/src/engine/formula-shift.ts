import {
    columnIndexToLabel,
    columnLabelToIndex,
    extractLabel,
    rowIndexToLabel,
    toLabel,
    unquoteSheetName,
} from './a1-notation';
import { iscelldata, operatorjson } from './formula-utils';
import { offsetCoordinate, offsetRange } from './parser/helper/cell';
import { error } from './validation';

// Returns [rowAbsolute, colAbsolute] for a single ref like "$A$1" → [true, true].
export function detectAbsolute(txt: string): [boolean, boolean] {
    const row = txt.replace(/[^0-9]/g, '');
    const col = txt.replace(/[^A-Za-z]/g, '');
    return [
        row.length > 0 && txt.charAt(txt.indexOf(row) - 1) === '$',
        col.length > 0 && txt.charAt(txt.indexOf(col) - 1) === '$',
    ];
}

// Same rules as the compiled formula's offset, so pasted text and a conditional format agree.
function shiftRef(txt: string, rowOffset: number, colOffset: number): string {
    const sheetEnd = txt.lastIndexOf('!') + 1;
    const prefix = txt.slice(0, sheetEnd);
    const [startTxt, endTxt] = txt.slice(sheetEnd).split(':');
    // walkFormulaRefs only hands over tokens `iscelldata` accepts, which extractLabel parses.
    const [startRow, startColumn] = extractLabel(startTxt)!;

    if (endTxt == null) {
        const row = offsetCoordinate(startRow, rowOffset, rowIndexToLabel);
        const column = offsetCoordinate(startColumn, colOffset, columnIndexToLabel);
        return row == null || column == null ? error['r'] : prefix + toLabel(row, column);
    }

    const [endRow, endColumn] = extractLabel(endTxt)!;
    const range = offsetRange([startRow, startColumn], [endRow, endColumn], rowOffset, colOffset);
    if (range == null) return error['r'];
    const [[rowStart, colStart], [rowEnd, colEnd]] = range;
    return `${prefix + toLabel(rowStart, colStart)}:${toLabel(rowEnd, colEnd)}`;
}

// Shared formula char-walker. Strips a single leading `=`, then splits the text into
// reference tokens vs structure — paren depth, double-quote state, `,`, `&`, and the
// operator handling (including glued two-char operators and leading-unary `-`) — and
// recurses into each bracketed / comma- / operator-separated segment. Every leaf token
// that `iscelldata` recognizes as a cell/range ref is passed to `onRef` and replaced by
// its return value; non-ref leaves pass through untouched. Pure — no Context, no DOM.
//
// `functionCopy` (relative shift) and `functionStrChange` (insert/delete shift) are the
// two consumers; they differ only in the per-ref transform they hand to `onRef`. The
// state-layer walker `isFunctionRange` (formula-exec.ts) looks similar but is a genuinely
// different machine — a shunting-yard compiler that emits `luckysheet_*` postfix and
// carries single-quote / `{}` array / `""`-escape state this walker has no notion of —
// so it is deliberately NOT built on this helper.
//
// A leading `-` is classified as a unary sign (glued to the following number literal) rather
// than a binary operator when the nearest non-space char before it is one of the unary-trigger
// chars (opening paren, comma, another operator) or the start of the segment. The scan reads
// i-1 first, then walks back over spaces: start at i-2 and the `-` in `CONCAT(-1:3)` reads as
// binary, shifting the trailing range.
function walkFormulaRefs(txt: string, onRef: (ref: string) => string): string {
    let stripped = txt;
    if (stripped.startsWith('=')) stripped = stripped.slice(1);

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
            result += `${walkFormulaRefs(str, onRef)})`;
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
            result += `${walkFormulaRefs(str, onRef)},`;
            str = '';
        } else if (s === '&' && dquote === 0) {
            if (str.length > 0) {
                result += `${walkFormulaRefs(str, onRef)}&`;
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
                    result += walkFormulaRefs(str, onRef) + s + sNext;
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
                result += walkFormulaRefs(str, onRef) + s;
                str = '';
            } else {
                result += s;
            }
        } else {
            str += s;
        }

        if (i === chars.length - 1) {
            const trimmed = str.trim();
            result += iscelldata(trimmed) ? onRef(trimmed) : trimmed;
        }

        i += 1;
    }

    return result;
}

// Shifts every cell-data ref in a formula by (rowOffset, colOffset), both axes at once.
// A leading `=` is stripped before processing; the returned text never carries one.
export function functionCopy(txt: string, rowOffset: number, colOffset: number): string {
    return walkFormulaRefs(txt, (ref) => shiftRef(ref, rowOffset, colOffset));
}

// Shifts formula-text refs in response to an insert ('add') or delete ('del') row/col
// op. `stindex` is the zero-based row/col index where the op starts; `step` is the
// count. `orient` ('lefttop' / 'rightbottom') controls whether the boundary row is
// included in the shift for insert ops. `targetSheet` names the sheet the op runs on
// and `onTargetSheet` says whether `txt` itself lives on that sheet — only refs that
// resolve to the target sheet move. Used by state/modules/rowcol.ts and (via
// engine/rowcol.ts) by the context-free replay path.
export function functionStrChange(
    txt: string,
    type: 'add' | 'del',
    rc: 'row' | 'col',
    orient: 'lefttop' | 'rightbottom' | null,
    stindex: number,
    step: number,
    targetSheet: string,
    onTargetSheet: boolean,
): string {
    if (!txt) {
        return '';
    }
    return walkFormulaRefs(txt, (ref) =>
        functionStrChange_range(ref, type, rc, orient, stindex, step, targetSheet, onTargetSheet),
    );
}

// Shifts a single cell or range ref string in response to an insert/delete row/col op.
// Invoked (via walkFormulaRefs) by functionStrChange for each ref token it finds.
function functionStrChange_range(
    txt: string,
    type: 'add' | 'del',
    rc: 'row' | 'col',
    orient: 'lefttop' | 'rightbottom' | null,
    stindex: number,
    step: number,
    targetSheet: string,
    onTargetSheet: boolean,
): string {
    const sheetSplit = txt.split('!');
    let rangetxt: string;
    let prefix = '';
    if (sheetSplit.length > 1) {
        [, rangetxt] = sheetSplit;
        prefix = `${sheetSplit[0]}!`;
        if (unquoteSheetName(sheetSplit[0]) !== targetSheet) return txt;
    } else {
        [rangetxt] = sheetSplit;
        if (!onTargetSheet) return txt;
    }

    const parts = rangetxt.split(':');
    const isRange = parts.length > 1;

    let r1: number;
    let r2: number;
    let c1: number;
    let c2: number;
    let $row0: string;
    let $col0: string;
    let $row1: string;
    let $col1: string;
    let rowsMissing: boolean;
    let colsMissing: boolean;

    if (!isRange) {
        const rowPart = parts[0].replace(/[^0-9]/g, '');
        const colPart = parts[0].replace(/[^A-Za-z]/g, '');

        // A single ref always carries both axes: `iscelldata` demands a column and a row.
        rowsMissing = false;
        colsMissing = false;

        r1 = Number.parseInt(rowPart, 10) - 1;
        r2 = r1;

        c1 = columnLabelToIndex(colPart);
        c2 = c1;

        const freezonFuc = detectAbsolute(parts[0]);
        $row0 = freezonFuc[0] ? '$' : '';
        $col0 = freezonFuc[1] ? '$' : '';
        $row1 = $row0;
        $col1 = $col0;
    } else {
        const rowPart0 = parts[0].replace(/[^0-9]/g, '');
        const rowPart1 = parts[1].replace(/[^0-9]/g, '');
        const colPart0 = parts[0].replace(/[^A-Za-z]/g, '');
        const colPart1 = parts[1].replace(/[^A-Za-z]/g, '');

        rowsMissing = rowPart0.length === 0 && rowPart1.length === 0;
        colsMissing = colPart0.length === 0 && colPart1.length === 0;

        r1 = rowsMissing ? -1 : Number.parseInt(rowPart0, 10) - 1;
        r2 = rowsMissing ? -1 : Number.parseInt(rowPart1, 10) - 1;
        if (!rowsMissing && r1 > r2) {
            return txt;
        }

        c1 = colsMissing ? -1 : columnLabelToIndex(colPart0);
        c2 = colsMissing ? -1 : columnLabelToIndex(colPart1);
        if (!colsMissing && c1 > c2) {
            return txt;
        }

        const freezonFuc0 = detectAbsolute(parts[0]);
        $row0 = freezonFuc0[0] ? '$' : '';
        $col0 = freezonFuc0[1] ? '$' : '';

        const freezonFuc1 = detectAbsolute(parts[1]);
        $row1 = freezonFuc1[0] ? '$' : '';
        $col1 = freezonFuc1[1] ? '$' : '';
    }

    const formatRange = () => {
        // A range collapses to a single label only when both axes were present in the
        // source text: a whole-column (`A:A`) or whole-row (`1:1`) range also satisfies
        // r1 === r2 && c1 === c2 through its -1 sentinels, and must keep both legs.
        if (!rowsMissing && !colsMissing && r1 === r2 && c1 === c2) {
            return prefix + $col0 + columnIndexToLabel(c1) + $row0 + (r1 + 1);
        }
        if (colsMissing) {
            return `${prefix + $row0 + (r1 + 1)}:${$row1}${r2 + 1}`;
        }
        if (rowsMissing) {
            return `${prefix + $col0 + columnIndexToLabel(c1)}:${$col1}${columnIndexToLabel(c2)}`;
        }
        return `${prefix + $col0 + columnIndexToLabel(c1) + $row0 + (r1 + 1)}:${$col1}${columnIndexToLabel(c2)}${$row1}${r2 + 1}`;
    };

    if (type === 'del') {
        if (rc === 'row' && !rowsMissing) {
            if (r1 >= stindex && r2 <= stindex + step - 1) {
                return error['r'];
            }
            if (r1 > stindex + step - 1) {
                r1 -= step;
            } else if (r1 >= stindex) {
                r1 = stindex;
            }
            if (r2 > stindex + step - 1) {
                r2 -= step;
            } else if (r2 >= stindex) {
                r2 = stindex - 1;
            }
            if (r1 < 0) {
                r1 = 0;
            }
            if (r2 < r1) {
                r2 = r1;
            }
        } else if (rc === 'col' && !colsMissing) {
            if (c1 >= stindex && c2 <= stindex + step - 1) {
                return error['r'];
            }
            if (c1 > stindex + step - 1) {
                c1 -= step;
            } else if (c1 >= stindex) {
                c1 = stindex;
            }
            if (c2 > stindex + step - 1) {
                c2 -= step;
            } else if (c2 >= stindex) {
                c2 = stindex - 1;
            }
            if (c1 < 0) {
                c1 = 0;
            }
            if (c2 < c1) {
                c2 = c1;
            }
        }
        return formatRange();
    }

    if (rc === 'row' && !rowsMissing) {
        if (orient === 'lefttop') {
            if (r1 >= stindex) r1 += step;
            if (r2 >= stindex) r2 += step;
        } else if (orient === 'rightbottom') {
            if (r1 > stindex) r1 += step;
            if (r2 > stindex) r2 += step;
        }
    } else if (rc === 'col' && !colsMissing) {
        if (orient === 'lefttop') {
            if (c1 >= stindex) c1 += step;
            if (c2 >= stindex) c2 += step;
        } else if (orient === 'rightbottom') {
            if (c1 > stindex) c1 += step;
            if (c2 > stindex) c2 += step;
        }
    }
    return formatRange();
}
