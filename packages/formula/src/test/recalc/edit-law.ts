// The edit law, as a run others can start with a seed and a count: random workbooks of adversarial shapes, driven
// through the public engine by writes, structural edits, recalcs that stop and undo, each step held against the
// model of edit-model.ts and a fresh engine loaded from it.

import type { Engine as EngineType, LineEdit, Move, Rewrite, SheetSource } from '../../index';
import { Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS } from '../../text';
import { random } from '../edit/support';
import type { Applied, Cell, Formula, Kept, Model, ModelSheet, Ref } from './edit-model';
import {
    applyAdd,
    applyLines,
    applyMove,
    applyRemove,
    applyRename,
    applyReorder,
    CELL,
    COLUMNS,
    clipped,
    columnOf,
    fresh,
    keyOf,
    RANGE,
    ROWS,
    rebound,
    rowOf,
    sourcesOf,
    textOf,
    written,
} from './edit-model';

const NO_CAP = Number.POSITIVE_INFINITY;

// Which lines a workbook uses: the first ones, or the first and the last ones of the rows or of the columns.
export const Edge = { None: 0, Rows: 1, Columns: 2 } as const;

// Every place a reference can stand that an edit treats its own way: #c a cell, #r a range, #C whole columns, #W
// whole rows.
const TEMPLATES = [
    '=#c',
    '=#c+#c',
    '=#c*2+1',
    '=SUM(#r)',
    '=SUM(#r)+#c',
    '=SUM(#r,#c)',
    '=AVERAGE(#r)',
    '=COUNTA(#r)',
    '=MIN(#r)',
    '=MAX(#r)',
    '=COUNT(#C)',
    '=SUM(#C)',
    '=SUM(#W)',
    '=ROW()',
    '=COLUMN()',
    '=ROW(#c)',
    '=ROW(#r)',
    '=COLUMN(#c)+#c',
    '=ROW()+#c',
    '=@#r',
    '=@#C',
    '=@#W',
    '=COUNTBLANK(#r)',
    '=COUNTIF(#r,"<>x")',
    '=MATCH(3,#r,0)',
    '=INDEX(#r,2)',
    '=VLOOKUP(2,#r,1,FALSE)',
    '=SUMPRODUCT(#r)',
    '=SUMPRODUCT(#r*1)',
    '=MATCH(2,#C,0)',
    '=INDEX(#C,3)',
    '=SUM((#c):(#c))',
    '=SUM(#r #r)',
    '=SUMIF(#r,">0",#r)',
    '=#r',
    '=IF(#c>2,#c,SUM(#r))',
];

// Stored text that is kept as it is: text that does not parse, a span of sheets and another workbook.
const RAW = ['=SUM(', "=SUM('Sheet1:Sheet2'!R1C1)", "='[1]Sheet1'!R1C1+1"];

export type Counts = {
    workbooks: number;
    lineEdits: number;
    moves: number;
    sheetEdits: number;
    unflagged: number;
    compared: number;
    values: number;
    loops: number;
    stopped: number;
    undone: number;
    rewrites: number;
    several: number;
};

type Op =
    | { kind: 'lines'; edit: LineEdit }
    | { kind: 'move'; move: Move }
    | { kind: 'add'; sheet: ModelSheet; place: number }
    | { kind: 'remove'; id: string }
    | { kind: 'rename'; id: string; name: string }
    | { kind: 'reorder'; id: string; place: number };

function show(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text);
    return `${typeof value}:${String(value)}`;
}

// A sheet as a host hands it over to be added: every formula that is computed comes with a value it once had,
// which is not to be trusted.
function handed(sheet: ModelSheet): SheetSource {
    const [source] = sourcesOf([sheet]);
    return {
        ...source,
        cells: (cell) =>
            source.cells((row, column, value, formula) =>
                cell(row, column, formula === null || RAW.includes(formula) ? value : 777, formula),
            ),
    };
}

function span(from: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => from + i);
}

// `sheets` weighs the sheet edits: 1 in so many steps is one.
export function runLaw(seed: number, count: number, steps: number, edge: number, sheets: number): Counts {
    const pick = random(seed);
    const one = <T>(list: readonly T[]): T => list[pick(list.length)];
    const counts: Counts = {
        workbooks: 0,
        lineEdits: 0,
        moves: 0,
        sheetEdits: 0,
        unflagged: 0,
        compared: 0,
        values: 0,
        loops: 0,
        stopped: 0,
        undone: 0,
        rewrites: 0,
        several: 0,
    };
    const rows = edge === Edge.Rows ? [...span(0, 5), ...span(GRID_ROWS - 6, 6)] : span(0, 10);
    const columns =
        edge === Edge.Columns ? [...span(0, 4), ...span(GRID_COLUMNS - 5, 5)] : span(0, edge === Edge.Rows ? 2 : 6);
    // Where a cell can end up: the lines in use and a few past the first ones.
    const scanRows = edge === Edge.Rows ? [...span(0, 11), ...span(GRID_ROWS - 6, 6)] : span(0, 16);
    const scanColumns = edge === Edge.Columns ? [...span(0, 9), ...span(GRID_COLUMNS - 5, 5)] : span(0, 10);

    for (let book = 0; book < count; book += 1) {
        let model: Model = [];
        let removed: ModelSheet[] = [];
        let renames = 0;
        const log: string[] = [];
        const where = () => `seed ${seed} book ${book}\n${log.join('\n')}\n`;

        const ref = (kind: number): Ref => {
            const drawn = pick(10);
            const later = model.every((sheet) => sheet.name !== 'Later');
            const sheet = drawn < 6 || drawn === 9 ? null : drawn === 8 ? 's3' : one(['s1', 's2', 's3']);
            const r1 = kind === COLUMNS ? 0 : one(rows);
            const c1 = kind === ROWS ? 0 : one(columns);
            return {
                sheet,
                name: drawn === 9 && later ? 'Later' : null,
                kind,
                r1,
                c1,
                r2: kind === CELL ? r1 : kind === COLUMNS ? 0 : one(rows),
                c2: kind === CELL ? c1 : kind === ROWS ? 0 : one(columns),
                fixed: pick(16),
                dead: false,
            };
        };
        const formula = (): Cell => {
            if (pick(30) === 0) return { value: null, formula: null, raw: one(RAW) };
            const pieces = one(TEMPLATES).split(/(#[crCW])/);
            const parts: string[] = [];
            const refs: Ref[] = [];
            pieces.forEach((piece, i) => {
                if (i % 2 === 0) parts.push(piece);
                else refs.push(ref(piece === '#c' ? CELL : piece === '#r' ? RANGE : piece === '#C' ? COLUMNS : ROWS));
            });
            return { value: null, formula: { parts, refs }, raw: null };
        };
        const value = (): Cell => ({ value: one([1, 2, 3, 3, 5, 8, 'x', true, 2.5]), formula: null, raw: null });
        // The formula as a fill writes it some rows down and columns across: what is relative moves along.
        const filled = (from: Formula, down: number, across: number): Cell => ({
            value: null,
            raw: null,
            formula: {
                parts: from.parts,
                refs: from.refs.map((held) => {
                    const r1 = held.kind === COLUMNS || held.fixed & 1 ? held.r1 : held.r1 + down;
                    const c1 = held.kind === ROWS || held.fixed & 2 ? held.c1 : held.c1 + across;
                    const r2 =
                        held.kind === CELL ? r1 : held.kind === COLUMNS || held.fixed & 4 ? held.r2 : held.r2 + down;
                    const c2 =
                        held.kind === CELL ? c1 : held.kind === ROWS || held.fixed & 8 ? held.c2 : held.c2 + across;
                    return { ...held, r1, c1, r2, c2 };
                }),
            },
        });
        const present = () => one(model).id;

        // The first workbook: three sheets of values and formulas, with blocks filled with one formula.
        for (const id of ['s1', 's2', 's3']) {
            const cells = new Map<number, Cell>();
            for (let i = 0; i < 22; i += 1)
                cells.set(keyOf(one(rows), one(columns)), pick(2) === 0 ? value() : formula());
            for (let block = 0; block < 2; block += 1) {
                const top = one(rows);
                const left = one(columns);
                const first = formula();
                for (let down = 0; down < 1 + pick(4) && top + down < GRID_ROWS; down += 1) {
                    for (let across = 0; across < 1 + pick(2) && left + across < GRID_COLUMNS; across += 1) {
                        const cell = first.formula === null ? first : filled(first.formula, down, across);
                        cells.set(keyOf(top + down, left + across), cell);
                    }
                }
            }
            model = [...model, { id, name: `Sheet${id.slice(1)}`, cells }];
        }
        const engine: EngineType = new Engine(sourcesOf(model));
        if (pick(2) === 0) engine.recalc(NO_CAP);
        // Whether something was written since the last edit or recalc, and how many edits since the last recalc.
        let unmarked = false;
        let edits = 0;

        const fail = (what: string): never => {
            throw new Error(`${what}\n${where()}`);
        };
        // The cells of every sheet that hold something in the model or could in the engine.
        const everyCell = (visit: (sheet: ModelSheet, row: number, column: number, cell: Cell | undefined) => void) => {
            for (const sheet of model) {
                const seen = new Set<number>();
                for (const row of scanRows) for (const column of scanColumns) seen.add(keyOf(row, column));
                for (const key of sheet.cells.keys()) seen.add(key);
                for (const key of seen) visit(sheet, rowOf(key), columnOf(key), sheet.cells.get(key));
            }
        };
        const inputs = () => {
            everyCell((sheet, row, column, cell) => {
                const text = cell === undefined ? null : textOf(cell, row, column);
                const held = engine.formulaOf(sheet.id, row, column);
                if (held !== text) fail(`${sheet.id} ${row},${column} holds ${held}, the model ${text}`);
                if (text !== null) return;
                const shown = show(engine.valueOf(sheet.id, row, column));
                const expected = show(cell === undefined ? null : cell.value);
                if (shown !== expected) fail(`${sheet.id} ${row},${column} holds ${shown}, the model ${expected}`);
            });
            model.forEach((sheet, place) => {
                if (engine.sheetAt(place) !== sheet.id) fail(`place ${place} is ${engine.sheetAt(place)}`);
            });
        };
        // Right after an edit: a formula that is not flagged already holds what a fresh load computes.
        const unflagged = () => {
            const { engine: loaded } = fresh(model);
            everyCell((sheet, row, column, cell) => {
                if (cell === undefined || cell.formula === null || engine.isPending(sheet.id, row, column)) return;
                const shown = show(engine.valueOf(sheet.id, row, column));
                const expected = show(loaded.valueOf(sheet.id, row, column));
                if (shown !== expected)
                    fail(`unflagged ${sheet.id} ${row},${column} holds ${shown}, fresh ${expected}`);
                counts.unflagged += 1;
            });
        };
        const settled = (loops: readonly { sheet: string; row: number; column: number }[]) => {
            const loaded = fresh(model);
            everyCell((sheet, row, column) => {
                const shown = show(engine.valueOf(sheet.id, row, column));
                const expected = show(loaded.engine.valueOf(sheet.id, row, column));
                if (shown !== expected) fail(`${sheet.id} ${row},${column} is ${shown}, fresh ${expected}`);
                if (engine.isPending(sheet.id, row, column)) fail(`${sheet.id} ${row},${column} is still pending`);
                counts.values += 1;
            });
            const found = loops.map((cell) => `${cell.sheet}!${cell.row},${cell.column}`).sort();
            if (found.join(' ') !== loaded.loops.join(' '))
                fail(`loops ${found.join(' ')}, fresh ${loaded.loops.join(' ')}`);
            counts.loops += found.length;
            counts.compared += 1;
            if (edits > 1) counts.several += 1;
            edits = 0;
        };
        const recalc = (cap: number) => {
            const before = new Map<string, string>();
            everyCell((sheet, row, column, cell) => {
                if (cell !== undefined)
                    before.set(`${sheet.id}!${row},${column}`, show(engine.valueOf(sheet.id, row, column)));
            });
            log.push(`recalc ${cap}`);
            const result = engine.recalc(cap);
            const listed = new Set<string>();
            for (let at = 0; at < result.changed.length; at += 4) {
                const id = engine.sheetAt(result.changed[at]);
                for (let row = result.changed[at + 2]; row <= result.changed[at + 3]; row += 1) {
                    listed.add(`${id}!${row},${result.changed[at + 1]}`);
                }
            }
            for (const [key, shown] of before) {
                const [id, place] = key.split('!');
                const [row, column] = place.split(',').map(Number);
                if (show(engine.valueOf(id, row, column)) !== shown && !listed.has(key))
                    fail(`${key} changed unlisted`);
            }
            unmarked = false;
            if (result.stopped) counts.stopped += 1;
            else settled(result.loops);
        };

        const cover = (applied: Applied, rewrites: readonly Rewrite[]) => {
            const kept = new Map<string, Kept>();
            for (const cell of applied.kept) kept.set(`${cell.sheet}!${cell.row},${cell.column}`, cell);
            const covered = new Set<string>();
            for (const rewrite of rewrites) {
                for (let row = rewrite.top; row <= rewrite.bottom; row += 1) {
                    for (let column = rewrite.left; column <= rewrite.right; column += 1) {
                        const key = `${rewrite.sheet}!${row},${column}`;
                        const cell = kept.get(key);
                        if (cell === undefined) return fail(`a rewrite of ${key}, which holds no formula`);
                        if (cell.after !== rewrite.formula)
                            fail(`a rewrite of ${key} to ${rewrite.formula}, not ${cell.after}`);
                        if (rewrite.lost === null && cell.before === cell.after) fail(`a rewrite of ${key}, unchanged`);
                        if (rewrite.lost !== null && rewrite.lost !== cell.before) fail(`${key} lost ${rewrite.lost}`);
                        if (covered.has(key)) fail(`two rewrites of ${key}`);
                        covered.add(key);
                    }
                }
            }
            for (const [key, cell] of kept) {
                if (cell.before !== cell.after && !covered.has(key))
                    fail(`no rewrite of ${key}: ${cell.before} to ${cell.after}`);
            }
            counts.rewrites += rewrites.length;
        };
        // Performs an edit on the engine and on the model, and holds the one against the other.
        const perform = (op: Op): { applied: Applied; rewrites: readonly Rewrite[] } => {
            log.push(JSON.stringify(op, (key, held) => (key === 'cells' ? undefined : held)));
            let applied: Applied;
            let rewrites: readonly Rewrite[] = [];
            let dropped = 0;
            let expected = 0;
            switch (op.kind) {
                case 'lines':
                    applied = applyLines(model, op.edit);
                    if (op.edit.insert) expected = applied.gone.length;
                    ({ rewrites, dropped } = engine.editLines(op.edit));
                    counts.lineEdits += 1;
                    break;
                case 'move': {
                    applied = applyMove(model, op.move);
                    const fit = clipped(op.move);
                    expected = applied.gone.filter(
                        (cell) =>
                            cell.sheet === op.move.fromSheet &&
                            cell.row >= op.move.row &&
                            cell.row < op.move.row + op.move.rows &&
                            cell.column >= op.move.column &&
                            cell.column < op.move.column + op.move.columns &&
                            (cell.row - op.move.row >= fit.rows || cell.column - op.move.column >= fit.columns),
                    ).length;
                    ({ rewrites, dropped } = engine.moveCells(op.move));
                    counts.moves += 1;
                    break;
                }
                case 'add':
                    applied = applyAdd(model, op.sheet, op.place);
                    ({ rewrites } = engine.addSheet(handed(op.sheet), op.place));
                    removed = removed.filter((sheet) => sheet.id !== op.sheet.id);
                    break;
                case 'remove': {
                    const gone = model.find((sheet) => sheet.id === op.id);
                    if (gone !== undefined) removed = [...removed, gone];
                    applied = { model: applyRemove(model, op.id), kept: [], gone: [] };
                    engine.removeSheet(op.id);
                    break;
                }
                case 'rename':
                    applied = applyRename(model, op.id, op.name);
                    ({ rewrites } = engine.renameSheet(op.id, op.name));
                    break;
                default:
                    applied = { model: applyReorder(model, op.id, op.place), kept: [], gone: [] };
                    engine.moveSheet(op.id, op.place);
            }
            if (op.kind !== 'lines' && op.kind !== 'move') counts.sheetEdits += 1;
            if (dropped !== expected) fail(`dropped ${dropped}, the model ${expected}`);
            model = applied.model;
            inputs();
            cover(applied, rewrites);
            unflagged();
            unmarked = false;
            edits += 1;
            return { applied, rewrites };
        };

        const lineEdit = (): Op => {
            const onRows = pick(2) === 0;
            const index = pick(8) === 0 ? 40 : one(onRows ? rows : columns);
            return {
                kind: 'lines',
                edit: { insert: pick(2) === 0, index, count: 1 + pick(3), sheet: present(), rows: onRows },
            };
        };
        const blockMove = (): Op => {
            const fromSheet = present();
            const toSheet = pick(3) === 0 ? present() : fromSheet;
            const tall = pick(40) === 0;
            const wide = !tall && pick(40) === 0;
            const move: Move = {
                fromSheet,
                row: tall ? 0 : one(rows),
                column: wide ? 0 : one(columns),
                rows: tall ? GRID_ROWS : 1 + pick(3),
                columns: wide ? GRID_COLUMNS : 1 + pick(2),
                toSheet,
                toRow: tall ? 0 : one(rows),
                toColumn: wide ? 0 : one(columns),
            };
            return { kind: 'move', move };
        };
        const sheetEdit = (): Op => {
            const drawn = pick(5);
            if (drawn === 0 && model.length > 1) return { kind: 'remove', id: present() };
            if (drawn === 1 && removed.length > 0) {
                // The host binds what the sheet holds to the sheets there are before it hands the sheet over.
                const later = model.find((sheet) => sheet.name === 'Later');
                const back = one(removed);
                const sheet = later === undefined ? back : rebound(back, 'Later', later.id);
                return { kind: 'add', sheet, place: pick(model.length + 1) };
            }
            if (
                drawn === 2 &&
                model.every((sheet) => sheet.id !== 's4') &&
                removed.every((sheet) => sheet.id !== 's4')
            ) {
                const cells = new Map<number, Cell>([
                    [keyOf(0, 0), value()],
                    [keyOf(1, 1), value()],
                ]);
                return { kind: 'add', sheet: { id: 's4', name: 'Later', cells }, place: pick(model.length + 1) };
            }
            if (drawn === 3) {
                renames += 1;
                const free = model.every((sheet) => sheet.name !== 'Later');
                return { kind: 'rename', id: present(), name: free && pick(2) === 0 ? 'Later' : `Named${renames}` };
            }
            return { kind: 'reorder', id: present(), place: pick(model.length) };
        };
        const anyEdit = (): Op => {
            const drawn = pick(6 + Math.ceil(12 / sheets));
            return drawn < 3 ? lineEdit() : drawn < 6 ? blockMove() : sheetEdit();
        };
        const write = (sheet: string, row: number, column: number, cell: Cell | null) => {
            const text = cell === null ? null : textOf(cell, row, column);
            log.push(`write ${sheet} ${row},${column} ${text ?? show(cell?.value ?? null)}`);
            if (cell === null) engine.clear(sheet, row, column);
            else if (text !== null) engine.setFormula(sheet, row, column, text);
            else if (cell.value !== null) engine.setValue(sheet, row, column, cell.value);
            model = written(model, sheet, row, column, cell);
            unmarked = true;
        };

        // What takes an edit back: the inverse edit, the cells it took out written back, and the texts it lost.
        const undo = (op: Op, before: Model, applied: Applied, rewrites: readonly Rewrite[]) => {
            log.push('undo');
            let back = (rewrite: Rewrite): Rewrite => rewrite;
            switch (op.kind) {
                case 'lines': {
                    const { edit } = op;
                    engine.editLines({ ...edit, insert: !edit.insert });
                    const line = (at: number) =>
                        at < edit.index ? at : edit.insert ? at - edit.count : at + edit.count;
                    back = (rewrite) => {
                        if (rewrite.sheet !== edit.sheet) return rewrite;
                        return edit.rows
                            ? { ...rewrite, top: line(rewrite.top), bottom: line(rewrite.bottom) }
                            : { ...rewrite, left: line(rewrite.left), right: line(rewrite.right) };
                    };
                    break;
                }
                case 'move': {
                    const move = clipped(op.move);
                    const down = move.toRow - move.row;
                    const across = move.toColumn - move.column;
                    engine.moveCells({
                        ...move,
                        fromSheet: move.toSheet,
                        row: move.toRow,
                        column: move.toColumn,
                        toSheet: move.fromSheet,
                        toRow: move.row,
                        toColumn: move.column,
                    });
                    back = (rewrite) => {
                        const carried =
                            rewrite.sheet === move.toSheet &&
                            rewrite.top >= move.toRow &&
                            rewrite.top < move.toRow + move.rows &&
                            rewrite.left >= move.toColumn &&
                            rewrite.left < move.toColumn + move.columns;
                        if (!carried) return rewrite;
                        return {
                            ...rewrite,
                            sheet: move.fromSheet,
                            top: rewrite.top - down,
                            bottom: rewrite.bottom - down,
                            left: rewrite.left - across,
                            right: rewrite.right - across,
                        };
                    };
                    break;
                }
                case 'add':
                    engine.removeSheet(op.sheet.id);
                    break;
                case 'remove': {
                    const place = before.findIndex((sheet) => sheet.id === op.id);
                    engine.addSheet(handed(before[place]), place);
                    break;
                }
                case 'rename':
                    engine.renameSheet(op.id, before.find((sheet) => sheet.id === op.id)?.name ?? '');
                    break;
                default:
                    engine.moveSheet(
                        op.id,
                        before.findIndex((sheet) => sheet.id === op.id),
                    );
            }
            for (const { sheet, row, column, cell } of applied.gone) {
                const text = textOf(cell, row, column);
                if (text !== null) engine.setFormula(sheet, row, column, text);
                else if (cell.value !== null) engine.setValue(sheet, row, column, cell.value);
            }
            for (const rewrite of rewrites) {
                if (rewrite.lost === null) continue;
                const { sheet, top, left, bottom, right } = back(rewrite);
                engine.fillFormula(sheet, top, left, bottom, right, rewrite.lost);
            }
            if (op.kind === 'add') removed = [...removed.filter((sheet) => sheet.id !== op.sheet.id), op.sheet];
            if (op.kind === 'remove') removed = removed.filter((sheet) => sheet.id !== op.id);
            model = before;
            log.push(`recalc ${NO_CAP}`);
            const { loops } = engine.recalc(NO_CAP);
            inputs();
            settled(loops);
            counts.undone += 1;
        };

        for (let step = 0; step < steps; step += 1) {
            const drawn = pick(16);
            if (drawn < 4) {
                const sheet = present();
                const row = one(rows);
                const column = one(columns);
                const what = pick(6);
                if (what === 0 && row + 2 < GRID_ROWS && column + 1 < GRID_COLUMNS) {
                    const first = formula();
                    const text = textOf(first, row, column);
                    if (first.formula === null || text === null) continue;
                    log.push(`fill ${sheet} ${row},${column} ${text}`);
                    engine.fillFormula(sheet, row, column, row + 2, column + 1, text);
                    for (let down = 0; down < 3; down += 1) {
                        for (let across = 0; across < 2; across += 1) {
                            model = written(
                                model,
                                sheet,
                                row + down,
                                column + across,
                                filled(first.formula, down, across),
                            );
                        }
                    }
                    unmarked = true;
                } else write(sheet, row, column, what === 1 ? null : what < 4 ? value() : formula());
            } else if (drawn < 10) perform(anyEdit());
            else if (drawn < 12) recalc(NO_CAP);
            else if (drawn < 14) recalc(1 + pick(8));
            else {
                // An edit, taken back, and done again. What was written before it is computed first, as undo's
                // one recalc holds against a fresh load only the values the inputs give.
                if (unmarked) recalc(NO_CAP);
                const before = model;
                const op = anyEdit();
                const { applied, rewrites } = perform(op);
                if (pick(2) === 0) recalc(NO_CAP);
                undo(op, before, applied, rewrites);
                perform(op);
                recalc(NO_CAP);
            }
        }
        recalc(NO_CAP);
        counts.workbooks += 1;
    }
    return counts;
}
