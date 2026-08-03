import { columnIndexToLabel, columnLabelToIndex } from './a1-notation';
import { iscelldata, operatorjson } from './formula-utils';
import { error } from './validation';

export type FormulaShiftMode = 'up' | 'down' | 'left' | 'right';

// Returns [rowAbsolute, colAbsolute] for a single ref like "$A$1" → [true, true].
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
//
// NOTE: this and `functionStrChange_range` parse+reformat refs with the same
// per-leg idiom (split on '!', split on ':', digits→row / letters→col,
// detectAbsolute, missing/frozen flags), but they are deliberately NOT merged
// into a shared parseRef/formatRef. They differ in row convention (this keeps
// rows 1-based throughout; `functionStrChange_range` works 0-based internally
// and +1s on output) and, more importantly, in their single-cell fallback: this
// branches on post-shift `rowValid`/`colValid`, while the other collapses via
// `r1===r2 && c1===c2` off explicit missing flags. A forced merge would have to
// rewrite one function's shift math onto the other's convention — high risk on
// the package's most formula-corruption-sensitive code for a few lines saved.
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
// chars (opening paren, comma, another operator) or the start of the segment. That predecessor
// is found by reading i-1 first, then scanning back over spaces — the char immediately before
// the `-`. (functionStrChange historically decremented before reading, skipping i-1 and starting
// at i-2; that misclassified e.g. the `-` in `CONCAT(-1:3)` as binary and shifted the trailing
// range. Both consumers now share this single read-i-1 scan.)
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

// Walks a formula string, finding cell-data refs and shifting them in the given
// direction. A leading `=` is stripped before processing; the returned text never
// carries one. Pure — no Context, no DOM. Negative `step` is allowed and reverses
// the direction. Used by:
//   - state/modules/condition-format.ts (CF formula rules)
//   - state/events/paste.ts (formula paste with relative refs)
//   - state/modules/sort.ts (sort moves formulas around)
//   - apps/api/src/lib/export/sheets/render.ts (server-side CF rule evaluation)
export function functionCopy(txt: string, mode: FormulaShiftMode = 'down', step = 1): string {
    const orient = mode[0] as 'd' | 'u' | 'l' | 'r';
    return walkFormulaRefs(txt, (ref) => shiftRef(orient, ref, step));
}

// Shifts formula-text refs in response to an insert ('add') or delete ('del') row/col
// op. `stindex` is the zero-based row/col index where the op starts; `step` is the
// count. `orient` ('lefttop' / 'rightbottom') controls whether the boundary row is
// included in the shift for insert ops. Used by state/modules/rowcol.ts and (via
// engine/rowcol.ts) by the context-free replay path.
export function functionStrChange(
    txt: string,
    type: string,
    rc: 'row' | 'col',
    orient: string | null,
    stindex: number,
    step: number,
): string {
    if (!txt) {
        return '';
    }
    return walkFormulaRefs(txt, (ref) => functionStrChange_range(ref, type, rc, orient, stindex, step));
}

// Shifts a single cell or range ref string in response to an insert/delete row/col op.
// Invoked (via walkFormulaRefs) by functionStrChange for each ref token it finds.
// See shiftRef's NOTE for why the two ref-parsers are not merged.
function functionStrChange_range(
    txt: string,
    type: string,
    rc: 'row' | 'col',
    orient: string | null,
    stindex: number,
    step: number,
): string {
    const sheetSplit = txt.split('!');
    let rangetxt: string;
    let prefix = '';
    if (sheetSplit.length > 1) {
        [, rangetxt] = sheetSplit;
        prefix = `${sheetSplit[0]}!`;
    } else {
        [rangetxt] = sheetSplit;
    }

    const parts = rangetxt.split(':');

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

    if (parts.length === 1) {
        const rowPart = parts[0].replace(/[^0-9]/g, '');
        const colPart = parts[0].replace(/[^A-Za-z]/g, '');

        rowsMissing = rowPart.length === 0;
        colsMissing = colPart.length === 0;

        r1 = rowsMissing ? -1 : Number.parseInt(rowPart, 10) - 1;
        r2 = r1;

        c1 = colsMissing ? -1 : columnLabelToIndex(colPart);
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
        if (r1 === r2 && c1 === c2) {
            if (!rowsMissing && !colsMissing) {
                return prefix + $col0 + columnIndexToLabel(c1) + $row0 + (r1 + 1);
            }
            if (!rowsMissing) {
                return prefix + $row0 + (r1 + 1);
            }
            if (!colsMissing) {
                return prefix + $col0 + columnIndexToLabel(c1);
            }
            return txt;
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

    if (type === 'add') {
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

    return '';
}
