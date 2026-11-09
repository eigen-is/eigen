// Reads and rewrites the references in a formula's text without parsing it: a copy or a fill shifts its relative refs,
// an inserted or deleted row or column moves the refs past it, a renamed sheet renames them and a deleted one breaks
// them, an xlsx import replaces each defined name with what it refers to, and the dependency walk lists them. One
// character walker finds the refs and the names for all of them. It reads only plain sheets, so the editor and the
// server share it, for example in the op replay and the recalc.

import type { Cell, Sheet } from '@workspace/lib/sheets';
import {
    a1RangeRef,
    extractLabel,
    MAX_SHEET_NAME_LENGTH,
    parseA1Range,
    sheetNameKey,
    sheetRefName,
    toLabel,
    unquoteSheetName,
} from './a1-notation';
import { formulaOperators, iscelldata, isFormula } from './formula-utils';
import { errorValues } from './parser/error';
import { offsetCoordinate, offsetRange, sortLegs } from './parser/helper/cell';
import { error } from './validation';

type RefLeg = NonNullable<ReturnType<typeof extractLabel>>;

// A sheet's name with every quote doubled, its two delimiters and its `!`.
const LONGEST_SHEET_PREFIX = 2 * MAX_SHEET_NAME_LENGTH + 3;

// Shifts every ref in a formula by rowOffset rows and colOffset columns, as a copy or a fill does. The text comes back
// without its leading `=`.
export function functionCopy(txt: string, rowOffset: number, colOffset: number): string {
    return walkFormulaRefs(txt, (ref) => shiftRef(ref, rowOffset, colOffset));
}

// Points every ref naming a renamed sheet at its new name, `Sheet1!A1` → `'Sheet1(Copy)'!A1`.
// `renames` maps the name of each renamed sheet to its new name. A leading `=` is kept.
export function renameSheetRefs(
    txt: string,
    findSheet: (name: string) => { name: string } | undefined,
    renames: ReadonlyMap<string, string>,
): string {
    if (renames.size === 0) return txt;
    return rewriteSheetRefs(txt, (ref, sheetEnd) => {
        const sheet = findSheet(unquoteSheetName(ref.slice(0, sheetEnd)));
        const name = sheet && renames.get(sheet.name);
        return name === undefined ? ref : `${sheetRefName(name)}${ref.slice(sheetEnd)}`;
    });
}

// Every ref naming a deleted sheet becomes #REF!, the text a row delete leaves. A leading `=` is kept.
export function breakSheetRefs(
    txt: string,
    findSheet: (name: string) => { name: string } | undefined,
    deleted: string,
): string {
    return rewriteSheetRefs(txt, (ref, sheetEnd) =>
        findSheet(unquoteSheetName(ref.slice(0, sheetEnd)))?.name === deleted ? error.r : ref,
    );
}

// True when a ref in the formula names `key`, a sheetNameKey, whether a sheet holds that name or not.
export function namesSheet(txt: string, key: string): boolean {
    let found = false;
    rewriteSheetRefs(txt, (ref, sheetEnd) => {
        if (sheetNameKey(unquoteSheetName(ref.slice(0, sheetEnd))) === key) found = true;
        return ref;
    });
    return found;
}

function rewriteSheetRefs(txt: string, rewrite: (ref: string, sheetEnd: number) => string): string {
    if (!txt.includes('!')) return txt;
    const rewritten = walkFormulaRefs(txt, (ref) => {
        const sheetEnd = ref.lastIndexOf('!');
        return sheetEnd > 0 ? rewrite(ref, sheetEnd) : ref;
    });
    return txt.startsWith('=') ? `=${rewritten}` : rewritten;
}

// The sheet with `rewrite` run over the formula text in its cells and formula rules.
// A sheet whose text stays comes back as the same object, and an untouched row keeps its object.
export function rewriteSheetFormulas<S extends Sheet>(sheet: S, rewrite: (txt: string) => string): S {
    const next = mapSheetCells(sheet, (cell) => {
        if (!isFormula(cell.f)) return cell;
        const f = rewrite(cell.f);
        return f === cell.f ? cell : { ...cell, f };
    });

    const rules = sheet.conditionalFormatRules;
    if (!rules) return next;
    let newRules: typeof rules | null = null;
    for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i];
        if (rule.type !== 'default' || rule.conditionName !== 'formula') continue;
        const txt = String(rule.conditionValue[0]);
        const rewritten = rewrite(txt);
        if (rewritten === txt) continue;
        newRules ??= [...rules];
        newRules[i] = { ...rule, conditionValue: [rewritten] };
    }
    return newRules ? { ...next, conditionalFormatRules: newRules } : next;
}

// The sheet with `rewrite` run over its cells, in the matrix or, on a sheet stored without one, the list. A cell that
// comes back as the same object costs no copy, and a sheet with no changed cell comes back as itself.
export function mapSheetCells<S extends Sheet>(sheet: S, rewrite: (cell: Cell) => Cell): S {
    if (sheet.data) {
        let data: typeof sheet.data | null = null;
        for (let r = 0; r < sheet.data.length; r += 1) {
            const row = sheet.data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
                const cell = row[c];
                if (!cell) continue;
                const next = rewrite(cell);
                if (next === cell) continue;
                data ??= [...sheet.data];
                if (data[r] === row) data[r] = [...row];
                data[r][c] = next;
            }
        }
        return data ? { ...sheet, data } : sheet;
    }
    if (!sheet.celldata) return sheet;
    let celldata: typeof sheet.celldata | null = null;
    for (let i = 0; i < sheet.celldata.length; i += 1) {
        const entry = sheet.celldata[i];
        if (!entry.v) continue;
        const v = rewrite(entry.v);
        if (v === entry.v) continue;
        celldata ??= [...sheet.celldata];
        celldata[i] = { ...entry, v };
    }
    return celldata ? { ...sheet, celldata } : sheet;
}

// Replaces each defined name in a formula with the text `resolve` gives for it, since the engine has no names.
// `resolve` gets every leaf that is no ref, a number included, and returns nothing for a leaf that stays.
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

// The text of a formula a cut or a drag moved, by Excel's rule: a ref wholly inside the moved block follows its cells,
// `$` or not, and any other ref still means the cell it meant, so on another sheet it names the one it came from.
// `from` and `to` are the sheets' names. The text comes back without its `=`.
export function moveFormulaRefs(
    txt: string,
    block: { row: readonly number[]; column: readonly number[] },
    rowOffset: number,
    colOffset: number,
    from: string,
    to: string,
    findSheet: (name: string) => { name: string } | undefined,
): string {
    const inBlock = ([row, column]: RefLeg) =>
        row.index >= block.row[0] &&
        row.index <= block.row[1] &&
        column.index >= block.column[0] &&
        column.index <= block.column[1];
    const moved = ([row, column]: RefLeg) =>
        toLabel({ ...row, index: row.index + rowOffset }, { ...column, index: column.index + colOffset });
    return walkFormulaRefs(txt, (ref) => {
        const sheetEnd = ref.lastIndexOf('!') + 1;
        if (sheetEnd > 0 && findSheet(unquoteSheetName(ref.slice(0, sheetEnd - 1)))?.name !== from) return ref;
        const [startTxt, endTxt] = ref.slice(sheetEnd).split(':');
        const start = extractLabel(startTxt);
        const end = endTxt == null ? start : extractLabel(endTxt);
        if (!start || !end || !inBlock(start) || !inBlock(end)) {
            return sheetEnd === 0 && from !== to ? `${sheetRefName(from)}!${ref}` : ref;
        }
        const prefix = sheetEnd > 0 ? `${sheetRefName(to)}!` : '';
        return endTxt == null ? prefix + moved(start) : `${prefix}${moved(start)}:${moved(end)}`;
    });
}

// Moves a formula's refs for a row or column insert ('add') or delete ('del'). Only refs to `targetSheet` move, and
// `findSheet` reads names by case, so in a workbook holding Data and data an op on one moves only its own refs.
export function functionStrChange(
    txt: string,
    type: 'add' | 'del',
    rc: 'row' | 'col',
    orient: 'lefttop' | 'rightbottom' | null,
    stindex: number,
    step: number,
    targetSheet: string,
    onTargetSheet: boolean,
    findSheet: (name: string) => { name: string } | undefined,
): string {
    if (!txt) return '';
    return walkFormulaRefs(txt, (ref) => {
        const sheetEnd = ref.lastIndexOf('!') + 1;
        const onSheet =
            sheetEnd > 0
                ? findSheet(unquoteSheetName(ref.slice(0, sheetEnd - 1)))?.name === targetSheet
                : onTargetSheet;
        return onSheet ? shiftRefForRowCol(ref, sheetEnd, type, rc, orient, stindex, step) : ref;
    });
}

const WALKER_REWRITES = /[^\S ]|: | :| $/;
const PRINTABLE_ASCII = /^[ -~]*$/;

// Whether functionStrChange may change a formula off the op's sheet, `name`, asked without the walk. Only a ref naming
// the sheet moves there, but the walker also writes back whitespace other than a space, a space beside a colon or at
// the end, and a range whose second leg names a sheet, so such text always takes the walk.
export function mayShiftOffSheet(name: string): (txt: string) => boolean {
    // A ref may spell each quote of the name single or doubled, so each run between quotes is looked for on its own.
    const runs = sheetNameKey(name)
        .split("'")
        .filter((run) => run !== '');
    return (txt) => {
        if (WALKER_REWRITES.test(txt)) return true;
        const bang = txt.lastIndexOf('!');
        if (bang < 0) return false;
        const colon = txt.indexOf(':');
        if (colon >= 0 && colon < bang) return true;
        // On ASCII text toUpperCase gives sheetNameKey's key without its step per character.
        const key = PRINTABLE_ASCII.test(txt) ? txt.toUpperCase() : sheetNameKey(txt);
        return runs.every((run) => key.includes(run));
    };
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

// The character walker every reader here shares. It drops one leading `=` and reads the text as leaves and structure.
// A leaf `iscelldata` reads as a ref goes to `onRef`; any other leaf goes to `onName`. A function name is no leaf.
export function walkFormulaRefs(
    txt: string,
    onRef: (ref: string) => string,
    onName: (token: string) => string = (token) => token,
): string {
    let str = '';
    let result = '';
    let dquote = false;
    // A quoted sheet name is one token, its delimiters and doubled quotes included.
    let squote = false;
    // A structured reference's brackets hold names, and a `'` escapes the character after it, a bracket too.
    let brackets = 0;
    const leaf = () => {
        const walked = refOf(str.trim(), onRef, onName);
        str = '';
        return walked;
    };

    for (let i = txt.startsWith('=') ? 1 : 0; i < txt.length; i += 1) {
        const s = txt[i];

        if (brackets > 0 || (s === '[' && !dquote && !squote)) {
            if (s === "'" && i + 1 < txt.length) {
                i += 1;
                str += s + txt[i];
            } else {
                if (s === '[') brackets += 1;
                else if (s === ']') brackets -= 1;
                str += s;
            }
        } else if (squote || (s === "'" && !dquote)) {
            if (s === "'") squote = !squote;
            str += s;
        } else if (s === '"') {
            str += '"';
            if (dquote) {
                result += str;
                str = '';
            }
            dquote = !dquote;
        } else if (dquote) {
            str += s;
        } else if (s === ' ') {
            // A run of spaces is read at once: kept, and between two refs the intersection operator, a bracketed one's
            // too (Excel reads `LOG10 (A1)` so); around a range's colon it is the range's.
            let end = i;
            while (txt[end + 1] === ' ') end += 1;
            if (txt[end + 1] !== ':' && !str.endsWith(':')) result += leaf() + ' '.repeat(end - i + 1);
            i = end;
        } else if (s === '(') {
            // A range may end at a function returning a reference, `B2:INDEX(…)`: its first leg is a ref.
            const legs = splitUnquoted(str, ':');
            const name = legs.pop();
            result += legs.length > 0 ? `${refOf(legs.join(':').trim(), onRef, onName)}:${name}(` : `${str}(`;
            str = '';
        } else if (s === ')' || s === ',') {
            result += leaf() + s;
        } else if (formulaOperators.has(s)) {
            const operator = formulaOperators.has(txt.slice(i, i + 2)) ? txt.slice(i, i + 2) : s;
            result += leaf() + operator;
            i += operator.length - 1;
        } else {
            // An error literal is one token: `#N/A` and `#DIV/0!` hold an operator, which reads their tail as a name.
            const literal = s === '#' && str === '' ? errorValues.find((text) => txt.startsWith(text, i)) : undefined;
            if (literal) result += literal;
            else str += s;
            i += (literal?.length ?? 1) - 1;
        }
    }

    return result + leaf();
}

// A range naming its sheet on both legs (`'S 1'!A1:'S 1'!B2`) moves as the one naming it once. A chained range
// (`A1:A2:A3`) moves leg by leg and is #REF! when any leg is.
function refOf(token: string, onRef: (ref: string) => string, onName: (token: string) => string): string {
    // The second leg of a range a function starts, `INDEX(…):A5`.
    if (token.startsWith(':') && token[1] !== ':') return `:${refOf(token.slice(1), onRef, onName)}`;
    const legs = splitUnquoted(token, ':');
    if (splitUnquoted(token, '!').length > 2) {
        if (legs.length !== 2 || legs.some((leg) => splitUnquoted(leg, '!').length !== 2)) return token;
        const sheetEnd = legs[1].lastIndexOf('!') + 1;
        const moved = refOf(`${legs[0]}:${legs[1].slice(sheetEnd)}`, onRef, onName);
        const colon = moved.lastIndexOf(':');
        if (colon < 0) return moved;
        const prefix = moved.slice(0, moved.lastIndexOf('!') + 1);
        return `${moved.slice(0, colon + 1)}${prefix}${moved.slice(colon + 1)}`;
    }
    const sheetEnd = token.lastIndexOf('!') + 1;
    const chained = token.slice(sheetEnd).split(':');
    if (chained.length <= 2) return iscelldata(token) ? onRef(token) : onName(token);
    const prefix = token.slice(0, sheetEnd);
    // Each leg reads the prefix, so a forged long one would cost its length squared. No sheet is called that.
    if (prefix.length > LONGEST_SHEET_PREFIX || !chained.every((leg) => iscelldata(leg))) return token;
    const moved = chained.map((leg) => onRef(prefix + leg));
    if (moved.includes(error.r)) return error.r;
    return [moved[0], ...moved.slice(1).map((leg) => leg.slice(leg.lastIndexOf('!') + 1))].join(':');
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

// Moves one cell or range ref on the op's sheet for functionStrChange. Its sheet's name, if it has one, ends before
// `sheetEnd`.
function shiftRefForRowCol(
    txt: string,
    sheetEnd: number,
    type: 'add' | 'del',
    rc: 'row' | 'col',
    orient: 'lefttop' | 'rightbottom' | null,
    stindex: number,
    step: number,
): string {
    const prefix = txt.slice(0, sheetEnd);

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
        // A whole-column or whole-row range meets this through its -1 sentinels and keeps both legs.
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
