import { expect, test } from 'bun:test';
import type { FormulaNode, Move, Span } from '../../text';
import {
    GONE,
    GRID_COLUMNS,
    GRID_ROWS,
    mapIndex,
    mapSpan,
    parseA1,
    printA1,
    printStored,
    rangeToA1,
    remapSheets,
    sheetFinder,
    toA1,
    transformLines,
    transformMove,
} from '../../text';
import { at } from '../text/support';
import type { Holder, Step, StructuralCase } from './structural-cases';
import { CASES } from './structural-cases';

// Where this engine's text differs from Excel's, and why. Excel's own text is the oracle's, checked by hand in Excel
// on the web for T2-61, T4-79, T6-107, T6-109, T7-112, T7-113, T7-117 and T7-119.
const OURS: Record<string, [string, string]> = {
    'T2-61': ['=B1:B1048575', 'Excel rewrites B1:B1048576 to B:B when it is typed; a typed range stays a range here'],
    'T4-79': ['=SUM(A1:A10)', 'the proposal: a range follows a move only when the whole range is in the block'],
    'T6-107': [
        '=Sheet2!A4',
        'the proposal: a sort is a copy per row; Excel keeps an offset to another sheet in a sort',
    ],
    'T6-109': ['=SUM(#REF!)', 'as T6-107; Excel by hand clips the range to =SUM(C1:C8) in a sort'],
    'T7-112': ['=#REF!', 'a deleted sheet prints as a bare #REF!, where Excel writes #REF!A1'],
    'T7-113': ['=#REF!', 'as T7-112; the new Sheet2 has another id and does not bind'],
    'T1-30': ["=SUM('Sheet2:Sheet4'!A5)", 'a 3-D reference is kept as typed and shown in quotes: not an Eigen feature'],
    'T7-114': ["=SUM('Sheet2:Sheet4'!A1)", 'as T1-30'],
    'T7-115': ["=SUM('Sheet2:Sheet4'!A1)", 'as T1-30'],
    'T7-116': ["=SUM('Sheet2:Sheet4'!A1)", 'as T1-30'],
    'T7-117': ["=SUM('Sheet2:Sheet3'!A1)", 'as T1-30'],
    'T7-118': ["=SUM('Sheet2:Sheet4'!A1)", 'as T1-30'],
    'T7-119': ["=SUM('Sheet2:Sheet4'!A1)", 'as T1-30'],
};

const NOT_RUN: Record<string, string> = {
    cellShift: 'insert or delete cells with a shift: not an edit this unit builds',
    lineMove: 'a move of whole rows or columns between others: not an edit this unit builds',
    described: 'the research describes it without a formula to run',
};

type Sheet = { id: string; name: string };
type Rect = { top: number; left: number; bottom: number; right: number };

// The one thing a case follows through its edits: a formula with its host, or a range with no formula.
type Subject = {
    sheets: Sheet[];
    tree: FormulaNode | null;
    sheet: string;
    row: number;
    column: number;
    range: Rect | null;
};

function sheetId(sheets: readonly Sheet[], name: string): string {
    const found = sheets.find((sheet) => sheet.name === name);
    if (!found) throw new Error(`no sheet ${name}`);
    return found.id;
}

// "Sheet1!A1:B4" → the sheet's id and the rectangle.
function place(sheets: readonly Sheet[], text: string): { sheet: string } & Rect {
    const [name, cells] = text.split('!');
    const [first, last = first] = cells.split(':');
    const [top, left] = at(first);
    const [bottom, right] = at(last);
    return { sheet: sheetId(sheets, name), top, left, bottom, right };
}

function parse(sheets: readonly Sheet[], text: string, row: number, column: number): FormulaNode {
    const parsed = parseA1(text, row, column, sheetFinder(sheets));
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason}`);
    return parsed;
}

function start(sheets: Sheet[], { host, formula, holder }: StructuralCase): Subject {
    if (holder === undefined) {
        if (host === null || formula === null) throw new Error('a case with nothing to follow');
        const { sheet, top, left } = place(sheets, host);
        return { sheets, tree: parse(sheets, formula, top, left), sheet, row: top, column: left, range: null };
    }
    // A name has no host: it is read as typed on no sheet at all, where only its absolute parts can move.
    if (holder.kind === 'name') {
        return { sheets, tree: parse(sheets, `=${holder.text}`, 0, 0), sheet: '', row: 0, column: 0, range: null };
    }
    const { sheet, ...range } = place(sheets, `${holder.sheet}!${holder.range}`);
    const tree = holder.kind === 'merge' ? null : parse(sheets, holder.text, range.top, range.left);
    return { sheets, tree, sheet, row: range.top, column: range.left, range };
}

// One step on the subject. The second value says the step lost what undo needs.
function apply(subject: Subject, step: Step, read: string | null): [Subject, boolean] {
    const { sheets, tree, sheet, row, column, range } = subject;
    switch (step.kind) {
        case 'lines': {
            const lines = step.rows ? GRID_ROWS : GRID_COLUMNS;
            const edit = { ...step, sheet: sheetId(sheets, step.sheet), lines };
            const onSheet = sheet === edit.sheet;
            let next = { ...subject };
            let lossy = false;
            if (range && onSheet) {
                const span: Span = { start: 0, end: 0 };
                const kept = step.rows
                    ? mapSpan(edit, range.top, range.bottom, span)
                    : mapSpan(edit, range.left, range.right, span);
                if (!kept) return [{ ...subject, tree: null, range: null }, true];
                next.range = step.rows
                    ? { ...range, top: span.start, bottom: span.end }
                    : { ...range, left: span.start, right: span.end };
            }
            if (tree) {
                const host = step.rows ? row : column;
                const result = transformLines(tree, edit, sheet, host);
                const moved = onSheet ? mapIndex(edit, host) : host;
                expect(moved).not.toBe(GONE);
                next = { ...next, tree: result.tree, row: step.rows ? moved : row, column: step.rows ? column : moved };
                lossy = result.lossy;
            }
            return [next, lossy];
        }
        case 'move': {
            const from = place(sheets, step.from);
            const to = place(sheets, step.to);
            const move: Move = {
                fromSheet: from.sheet,
                row: from.top,
                column: from.left,
                rows: from.bottom - from.top + 1,
                columns: from.right - from.left + 1,
                toSheet: to.sheet,
                toRow: to.top,
                toColumn: to.left,
            };
            if (!tree) throw new Error('a move of a range holder');
            const inside = (blockSheet: string, top: number, left: number) =>
                sheet === blockSheet &&
                row >= top &&
                row < top + move.rows &&
                column >= left &&
                column < left + move.columns;
            const carried = inside(move.fromSheet, move.row, move.column);
            // A formula the block lands on is overwritten: the store's loss, which undo restores.
            if (!carried && inside(move.toSheet, move.toRow, move.toColumn)) return [{ ...subject, tree: null }, true];
            const result = transformMove(tree, move, sheet, row, column);
            const moved = carried
                ? {
                      sheet: move.toSheet,
                      row: row + move.toRow - move.row,
                      column: column + move.toColumn - move.column,
                  }
                : {};
            return [{ ...subject, tree: result.tree, ...moved }, result.lossy];
        }
        // A copy, a fill and a sort put the stored text at a new host, and transform nothing.
        case 'copy': {
            const from = place(sheets, step.from);
            if (subject.range || sheet !== from.sheet || row !== from.top || column !== from.left)
                return [subject, false];
            const to = place(sheets, step.to);
            return [{ ...subject, sheet: to.sheet, row: to.top, column: to.left }, false];
        }
        case 'fill':
        case 'sort': {
            const block = place(sheets, `${step.sheet}!${step.range}`);
            const inside = row >= block.top && row <= block.bottom && column >= block.left && column <= block.right;
            if (sheet !== block.sheet || !inside || read === null) return [subject, false];
            const to = place(sheets, read);
            return [{ ...subject, row: to.top, column: to.left }, false];
        }
        case 'renameSheet':
            return [
                { ...subject, sheets: sheets.map((s) => (s.name === step.from ? { id: s.id, name: step.to } : s)) },
                false,
            ];
        case 'deleteSheet':
            return [{ ...subject, sheets: sheets.filter((s) => s.name !== step.name) }, true];
        case 'addSheet':
            return [{ ...subject, sheets: [...sheets, { id: `new-${step.name}`, name: step.name }] }, false];
        // The cells of the copy keep their stored text, and what named the source sheet by id now names the copy.
        case 'copySheet': {
            const source = sheetId(sheets, step.name);
            if (!tree || sheet !== source) throw new Error('a copy of a sheet the formula is not on');
            return [
                {
                    ...subject,
                    sheets: [...sheets, { id: 'copy', name: step.newName }],
                    tree: remapSheets(tree, new Map([[source, 'copy']])),
                    sheet: 'copy',
                },
                false,
            ];
        }
        case 'nothing':
            return [subject, false];
        default:
            throw new Error(`${step.kind} is not run`);
    }
}

// The step that takes back a step that lost nothing.
function inverse(step: Step): Step {
    if (step.kind === 'lines') return { ...step, insert: !step.insert };
    if (step.kind === 'move') {
        const [sheet, cells] = step.from.split('!');
        const [first, last = first] = cells.split(':');
        const [top, left] = at(first);
        const [bottom, right] = at(last);
        const [toSheet, toCell] = step.to.split('!');
        const [toTop, toLeft] = at(toCell);
        const landed = `${toA1(toTop, toLeft)}:${toA1(toTop + bottom - top, toLeft + right - left)}`;
        return { kind: 'move', from: `${toSheet}!${landed}`, to: `${sheet}!${first}` };
    }
    throw new Error(`no inverse of ${step.kind}`);
}

function shown(subject: Subject, holder: Holder | undefined): string {
    const { sheets, tree, row, column, range } = subject;
    const text = tree ? printA1(tree, row, column, (id) => sheets.find((sheet) => sheet.id === id)?.name) : '';
    if (holder === undefined || holder.kind === 'validation') return text;
    if (holder.kind === 'name') return text.slice(1);
    if (range === null) return '(none)';
    const cells = rangeToA1({ row: [range.top, range.bottom], column: [range.left, range.right] });
    return holder.kind === 'merge' ? cells : `${cells} | ${text}`;
}

function notRun({ steps }: StructuralCase): string | undefined {
    if (steps.length === 0) return NOT_RUN.described;
    return steps.some((step) => step.kind === 'cellShift')
        ? NOT_RUN.cellShift
        : steps.some((step) => step.kind === 'lineMove')
          ? NOT_RUN.lineMove
          : undefined;
}

test('the fixture holds the 219 cases, and 26 of them are not run', () => {
    expect(CASES.length).toBe(219);
    const skipped = CASES.filter((one) => notRun(one) !== undefined).map((one) => one.id);
    expect(skipped.length).toBe(26);
    expect(Object.keys(OURS).filter((id) => skipped.includes(id))).toEqual([]);
});

test.each(
    CASES.filter((one) => notRun(one) === undefined).map((one): [string, StructuralCase] => [
        `${one.id} ${one.formula ?? one.holder?.kind} ${one.steps.map((step) => step.kind).join(', ')}`,
        one,
    ]),
)('%s', (_, one) => {
    let subject = start(
        one.sheets.map((name, i) => ({ id: `s${i + 1}`, name })),
        one,
    );
    const done: { before: Subject; step: Step; lossy: boolean }[] = [];
    const undone: Step[] = [];
    for (const step of one.steps) {
        if (step.kind === 'undo') {
            const last = done.pop();
            if (!last) throw new Error('nothing to undo');
            // Undo keeps the old text of a lossy step, and the inverse edit must give back everything else.
            if (!last.lossy && (last.step.kind === 'lines' || last.step.kind === 'move')) {
                const [back] = apply(subject, inverse(last.step), null);
                expect(back.tree && printStored(back.tree)).toBe(last.before.tree && printStored(last.before.tree));
                expect([back.sheet, back.row, back.column]).toEqual([
                    last.before.sheet,
                    last.before.row,
                    last.before.column,
                ]);
            }
            subject = last.before;
            undone.push(last.step);
            continue;
        }
        const next = step.kind === 'redo' ? undone.pop() : step;
        if (!next) throw new Error('nothing to redo');
        const [after, lossy] = apply(subject, next, one.read);
        done.push({ before: subject, step: next, lossy });
        subject = after;
    }
    expect(shown(subject, one.holder)).toBe(OURS[one.id]?.[0] ?? one.expected);
    if (one.read !== null) {
        const name = subject.sheets.find((sheet) => sheet.id === subject.sheet)?.name;
        expect(`${name}!${toA1(subject.row, subject.column)}`).toBe(one.read);
    }
});
