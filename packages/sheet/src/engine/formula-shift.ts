// Rewrites the references in a formula's text without parsing it: a copy or a fill shifts its relative refs, an inserted
// or deleted row or column moves the refs past it, a renamed sheet renames them, and an xlsx import replaces each
// defined name with what it refers to. One character walker finds the refs and the names for all of them. It needs no
// sheet state, so the editor and the server share it, for example in the op replay and the xlsx import.

import {
    a1RangeRef,
    extractLabel,
    parseA1Range,
    sheetNameKey,
    sheetRefName,
    toLabel,
    unquoteSheetName,
} from './a1-notation';
import { formulaOperators, iscelldata } from './formula-utils';
import { offsetCoordinate, offsetRange, sortLegs } from './parser/helper/cell';
import { error } from './validation';

// Shifts every ref in a formula by rowOffset rows and colOffset columns, as a copy or a fill does. The text comes back
// without its leading `=`.
export function functionCopy(txt: string, rowOffset: number, colOffset: number): string {
    return walkFormulaRefs(txt, (ref) => shiftRef(ref, rowOffset, colOffset));
}

// Points every ref naming a renamed sheet at its new name, `Sheet1!A1` → `'Sheet1(Copy)'!A1`: Import… renames an
// imported tab whose name the workbook holds. A leading `=` is kept.
export function renameSheetRefs(txt: string, renames: ReadonlyMap<string, string>): string {
    if (renames.size === 0 || !txt.includes('!')) return txt;
    const byKey = new Map([...renames].map(([from, to]) => [sheetNameKey(from), to]));
    const renamed = walkFormulaRefs(txt, (ref) => {
        const sheetEnd = ref.lastIndexOf('!');
        const name = sheetEnd > 0 ? byKey.get(sheetNameKey(unquoteSheetName(ref.slice(0, sheetEnd)))) : undefined;
        return name === undefined ? ref : `${sheetRefName(name)}${ref.slice(sheetEnd)}`;
    });
    return txt.startsWith('=') ? `=${renamed}` : renamed;
}

// Replaces each defined name in a formula with the text `resolve` gives for it, as an xlsx import does, since the
// engine has no names. `resolve` gets every leaf that is no ref, such as a name or a number, as written, and the sheet
// a `Sheet1!Name` qualifies it with, unquoted. It returns nothing for a leaf that stays. A function of the same name
// is still called. A formula without a name comes back as written, and a leading `=` is kept.
export function inlineNames(
    txt: string,
    resolve: (name: string, sheet: string | undefined) => string | undefined,
): string {
    let inlined = false;
    const name = (token: string) => {
        const sheetEnd = token.lastIndexOf('!');
        const text = resolve(
            token.slice(sheetEnd + 1),
            sheetEnd > 0 ? unquoteSheetName(token.slice(0, sheetEnd)) : undefined,
        );
        if (text === undefined) return token;
        inlined = true;
        return text;
    };
    // The walker reads a name such as RhoCO2 as a cell. Its column is past Excel's last, so Excel reads it as a name.
    const ref = (token: string) => {
        const range = /[$:]/.test(token) ? null : parseA1Range(token);
        return range && !a1RangeRef(range) ? name(token) : token;
    };
    const walked = walkFormulaRefs(txt, ref, name);
    if (!inlined) return txt;
    return txt.startsWith('=') ? `=${walked}` : walked;
}

// Moves a formula's refs for a row or column insert ('add') or delete ('del'), on the editor and in the op replay
// alike. `stindex` is the first row or column the op touches and `step` how many. `orient` says whether an insert at
// `stindex` moves a ref that starts there. `targetSheet` names the sheet the op runs on, and `onTargetSheet` says
// whether the formula lives on it. Only refs to that sheet move.
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
        shiftRefForRowCol(ref, type, rc, orient, stindex, step, targetSheet, onTargetSheet),
    );
}

// Returns [rowAbsolute, colAbsolute] for a single ref like "$A$1" → [true, true].
export function detectAbsolute(txt: string): [boolean, boolean] {
    const row = txt.replace(/[^0-9]/g, '');
    const col = txt.replace(/[^A-Za-z]/g, '');
    return [
        row.length > 0 && txt.charAt(txt.indexOf(row) - 1) === '$',
        col.length > 0 && txt.charAt(txt.indexOf(col) - 1) === '$',
    ];
}

// The character walker every rewrite here shares. It drops one leading `=`, then reads the text as refs and the
// structure around them: brackets, strings, commas, `&` and the operators, a two-character one or a leading minus
// included. It walks into each part between them. Each leaf that `iscelldata` reads as a ref goes to `onRef`, which
// returns its replacement. Any other leaf, such as a name or a number, goes to `onName`, which keeps it by default. A
// function's name is no leaf, and neither is a string.
//
// A `-` is a sign, glued to the number after it, when the nearest character before it that is no space is `(`, `,`,
// another operator, or the start of the part. The scan reads the character just before the `-` first and then walks
// back over spaces. Starting one further back would read the `-` in `CONCAT(-1:3)` as a minus and shift the range.
function walkFormulaRefs(
    txt: string,
    onRef: (ref: string) => string,
    onName: (token: string) => string = (token) => token,
): string {
    const chars = (txt.startsWith('=') ? txt.slice(1) : txt).split('');
    let i = 0;
    let str = '';
    let result = '';
    let dquote = 0;
    // A quoted sheet name is one token, its delimiters and doubled quotes included.
    let squote = false;
    // A structured reference's brackets hold names, and a `'` escapes the character after it, a bracket too.
    let brackets = 0;

    while (i < chars.length) {
        const s = chars[i];

        if (brackets > 0 || (s === '[' && dquote === 0 && !squote)) {
            if (s === "'" && i + 1 < chars.length) {
                i += 1;
                str += s + chars[i];
            } else {
                if (s === '[') brackets += 1;
                else if (s === ']') brackets -= 1;
                str += s;
            }
        } else if (squote || (s === "'" && dquote === 0)) {
            if (s === "'") squote = !squote;
            str += s;
        } else if (s === ' ' && dquote === 0) {
            // A run of spaces is read at once: kept, and between two refs the intersection operator, a bracketed one's
            // too (Excel reads `LOG10 (A1)` so); around a range's colon it is the range's.
            let end = i;
            while (end + 1 < chars.length && chars[end + 1] === ' ') end += 1;
            if (chars[end + 1] !== ':' && !str.endsWith(':')) {
                result += walkFormulaRefs(str, onRef, onName) + ' '.repeat(end - i + 1);
                str = '';
            }
            i = end;
        } else if (s === '(' && dquote === 0) {
            // A range may end at a function returning a reference, `B2:INDEX(…)`: its first leg is a ref.
            const legs = splitUnquoted(str, ':');
            const name = legs.pop();
            result += legs.length > 0 ? `${refOf(legs.join(':').trim(), onRef, onName)}:${name}(` : `${str}(`;
            str = '';
        } else if (s === ')' && dquote === 0) {
            result += `${walkFormulaRefs(str, onRef, onName)})`;
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
            result += `${walkFormulaRefs(str, onRef, onName)},`;
            str = '';
        } else if (s === '&' && dquote === 0) {
            if (str.length > 0) {
                result += `${walkFormulaRefs(str, onRef, onName)}&`;
                str = '';
            } else {
                result += '&';
            }
        } else if (formulaOperators.has(s) && dquote === 0) {
            const sNext = i + 1 < chars.length ? chars[i + 1] : '';
            let p = i - 1;
            let sPre: string | null = null;
            if (p >= 0) {
                do {
                    sPre = chars[p];
                    p -= 1;
                } while (p >= 0 && sPre === ' ');
            }

            if (formulaOperators.has(s + sNext)) {
                if (str.length > 0) {
                    result += walkFormulaRefs(str, onRef, onName) + s + sNext;
                    str = '';
                } else {
                    result += s + sNext;
                }
                i += 1;
            } else if (
                !/[^0-9]/.test(sNext) &&
                s === '-' &&
                (sPre === '(' || sPre == null || sPre === ',' || sPre === ' ' || formulaOperators.has(sPre))
            ) {
                str += s;
            } else if (str.length > 0) {
                result += walkFormulaRefs(str, onRef, onName) + s;
                str = '';
            } else {
                result += s;
            }
        } else {
            str += s;
        }

        if (i === chars.length - 1) {
            result += refOf(str.trim(), onRef, onName);
        }

        i += 1;
    }

    return result;
}

// A leaf the walker found: a ref is handed to `onRef` as one or two legs behind one sheet prefix. A range naming its
// sheet on both legs (`'S 1'!A1:'S 1'!B2`) moves as the one naming it once, and a chained range (`A1:A2:A3`) leg by
// leg, so its result is #REF! when any leg's is.
function refOf(token: string, onRef: (ref: string) => string, onName: (token: string) => string): string {
    // The second leg of a range a function starts, `INDEX(…):A5`.
    if (token.startsWith(':')) return `:${refOf(token.slice(1), onRef, onName)}`;
    const legs = splitUnquoted(token, ':');
    if (splitUnquoted(token, '!').length > 2) {
        if (legs.length !== 2 || legs.some((leg) => splitUnquoted(leg, '!').length !== 2)) return token;
        const second = legs[1].slice(0, legs[1].lastIndexOf('!') + 1);
        const moved = refOf(`${legs[0]}:${legs[1].slice(second.length)}`, onRef, onName);
        const colon = moved.lastIndexOf(':');
        return colon < 0 ? moved : `${moved.slice(0, colon + 1)}${second}${moved.slice(colon + 1)}`;
    }
    const sheetEnd = token.lastIndexOf('!') + 1;
    const chained = token.slice(sheetEnd).split(':');
    if (chained.length <= 2) return iscelldata(token) ? onRef(token) : onName(token);
    const prefix = token.slice(0, sheetEnd);
    if (!chained.every((leg) => iscelldata(leg))) return token;
    const moved = chained.map((leg) => onRef(prefix + leg));
    if (moved.includes(error.r)) return error.r;
    return [moved[0], ...moved.slice(1).map((leg) => leg.slice(prefix.length))].join(':');
}

// Splits on `separator` outside single quotes, which hold sheet names.
function splitUnquoted(text: string, separator: string): string[] {
    const parts: string[] = [];
    let quoted = false;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "'") quoted = !quoted;
        else if (text[index] === separator && !quoted) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

// Same rules as the compiled formula's offset, so pasted text and a conditional format agree.
function shiftRef(txt: string, rowOffset: number, colOffset: number): string {
    const sheetEnd = txt.lastIndexOf('!') + 1;
    const prefix = txt.slice(0, sheetEnd);
    const [startTxt, endTxt] = txt.slice(sheetEnd).split(':');
    // walkFormulaRefs only hands over tokens `iscelldata` accepts, which extractLabel parses.
    const start = extractLabel(startTxt);
    if (!start) return txt;
    const [startRow, startColumn] = start;

    if (endTxt == null) {
        const row = offsetCoordinate(startRow, rowOffset, 'row');
        const column = offsetCoordinate(startColumn, colOffset, 'column');
        return row == null || column == null ? error.r : prefix + toLabel(row, column);
    }

    const end = extractLabel(endTxt);
    if (!end) return txt;
    const [endRow, endColumn] = end;
    const range = offsetRange([startRow, startColumn], [endRow, endColumn], rowOffset, colOffset);
    if (range == null) return error.r;
    const [[rowStart, colStart], [rowEnd, colEnd]] = range;
    return `${prefix + toLabel(rowStart, colStart)}:${toLabel(rowEnd, colEnd)}`;
}

// Moves one cell or range ref for functionStrChange.
function shiftRefForRowCol(
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
    const onSheet =
        sheetEnd > 0
            ? sheetNameKey(unquoteSheetName(prefix.slice(0, -1))) === sheetNameKey(targetSheet)
            : onTargetSheet;
    if (!onSheet) return txt;

    const [startTxt, endTxt = startTxt] = txt.slice(sheetEnd).split(':');
    // As in shiftRef: every token walkFormulaRefs hands over parses.
    const start = extractLabel(startTxt);
    const end = extractLabel(endTxt);
    if (!start || !end) return txt;
    const [startRow, startColumn] = start;
    const [endRow, endColumn] = end;
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
        // A range wholly inside the deleted band is #REF!, and one that overlaps it loses the deleted part.
        const last = stindex + step - 1;
        const afterDelete = (from: number, to: number): [number, number] | null => {
            if (from >= stindex && to <= last) return null;
            let start = from;
            if (from > last) start -= step;
            else if (from >= stindex) start = stindex;
            let end = to;
            if (to > last) end -= step;
            else if (to >= stindex) end = stindex - 1;
            start = Math.max(start, 0);
            return [start, Math.max(end, start)];
        };
        if (rc === 'row' && !rowsMissing) {
            const rows = afterDelete(r1, r2);
            if (rows == null) return error.r;
            [r1, r2] = rows;
        } else if (rc === 'col' && !colsMissing) {
            const columns = afterDelete(c1, c2);
            if (columns == null) return error.r;
            [c1, c2] = columns;
        }
        return formatRange();
    }

    // An insert at the boundary moves it for 'lefttop' and leaves it for 'rightbottom'.
    const afterInsert = (index: number) =>
        (orient === 'lefttop' ? index >= stindex : orient === 'rightbottom' && index > stindex) ? index + step : index;
    if (rc === 'row' && !rowsMissing) {
        r1 = afterInsert(r1);
        r2 = afterInsert(r2);
    } else if (rc === 'col' && !colsMissing) {
        c1 = afterInsert(c1);
        c2 = afterInsert(c2);
    }
    return formatRange();
}
