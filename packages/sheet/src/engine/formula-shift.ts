import { extractLabel, toLabel, unquoteSheetName } from './a1-notation';
import { iscelldata, operatorjson } from './formula-utils';
import { offsetCoordinate, offsetRange, sortLegs } from './parser/helper/cell';
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
        const row = offsetCoordinate(startRow, rowOffset, 'row');
        const column = offsetCoordinate(startColumn, colOffset, 'column');
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
    const sheetEnd = txt.lastIndexOf('!') + 1;
    const prefix = txt.slice(0, sheetEnd);
    if (sheetEnd > 0 ? unquoteSheetName(prefix.slice(0, -1)) !== targetSheet : !onTargetSheet) return txt;

    const [startTxt, endTxt = startTxt] = txt.slice(sheetEnd).split(':');
    const [startRow, startColumn] = extractLabel(startTxt)!;
    const [endRow, endColumn] = extractLabel(endTxt)!;
    const [row0, row1] = sortLegs(startRow, endRow);
    const [column0, column1] = sortLegs(startColumn, endColumn);

    let r1 = row0.index;
    let r2 = row1.index;
    let c1 = column0.index;
    let c2 = column1.index;
    const rowsMissing = r1 === -1 && r2 === -1;
    const colsMissing = c1 === -1 && c2 === -1;

    const formatRange = () => {
        const start = prefix + toLabel({ ...row0, index: r1 }, { ...column0, index: c1 });
        // A whole-column (`A:A`) or whole-row (`1:1`) range also meets this through its -1 sentinels, and keeps both legs.
        if (!rowsMissing && !colsMissing && r1 === r2 && c1 === c2) {
            return start;
        }
        return `${start}:${toLabel({ ...row1, index: r2 }, { ...column1, index: c2 })}`;
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
