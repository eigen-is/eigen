import { isRecord } from '@workspace/lib/guards';
import type { Cell, Op, Sheet } from '@workspace/lib/sheets';
import { FormulaEngine } from '../../../engine/formula-engine';
import { FormulaGraph } from '../../../engine/formula-graph';
import { recomputeAfter } from '../../../engine/recalc';
import { replaySheetsOps, withMaterializedData } from '../../../engine/replay-ops';

// A seeded generator, so a failure names the seed and batch that reproduce it.
export function random(seed: number) {
    let s = seed >>> 0;
    const next = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(next() * n);
    const pick = <T>(items: readonly T[]): T => items[int(items.length)];
    return { int, pick, chance: (p: number) => next() < p };
}
export type Random = ReturnType<typeof random>;

const ROWS = 9;
const COLUMNS = 6;
export const letter = (c: number) => String.fromCharCode(65 + c);
export const constant = (v: number): Cell => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });

// A formula on sheet `level` in column `column` reads only columns to its left on its own sheet, or any cell of a
// sheet of a lower level. A row or column op keeps that order, so the workbook stays free of cycles.
export function formulaFor(rnd: Random, names: readonly string[], level: number, column: number): string {
    const row = () => 1 + rnd.int(ROWS);
    const left = () => letter(rnd.int(Math.max(1, column)));
    const lower = level > 0 ? names.slice(0, level) : [];
    const other = () => {
        const name = rnd.pick(lower);
        return name.includes(' ') ? `'${name}'` : name;
    };
    const own = [
        () => `=${left()}${row()}+1`,
        () => `=$${left()}$${row()}*2`,
        () => {
            const a = row();
            const b = row();
            return `=SUM(${left()}${Math.min(a, b)}:${left()}${Math.max(a, b)})`;
        },
        () => `=SUM(${left()}:${left()})`,
        () => `=COUNT(A${row()}:${left()}${ROWS})`,
    ];
    const across = [
        () => `=${other()}!${letter(rnd.int(COLUMNS))}${row()}`,
        () => `=SUM(${other()}!A1:B${row()})+${left()}${row()}`,
        () => `=SUM(${other()}!${letter(rnd.int(COLUMNS))}:${letter(rnd.int(COLUMNS))})`,
        () => `=SUM(${other()}!${row()}:${row()})`,
        () => `=${other()}!$A$${row()}*${left()}1`,
    ];
    return (lower.length > 0 && rnd.chance(0.5) ? rnd.pick(across) : rnd.pick(own))();
}

// The level a sheet's formulas may read below, by sheet id: the workbook's own sheets first, then the added ones.
const LEVELS: Record<string, number> = { s1: 0, s2: 1, s3: 2, s4: 1, s5: 2 };

export function workbook(rnd: Random): Sheet[] {
    const names = ['One', 'Two', 'Three'];
    return names.map((name, level) => {
        const data: (Cell | null)[][] = [];
        for (let r = 0; r < ROWS; r += 1) {
            const row: (Cell | null)[] = [];
            for (let c = 0; c < COLUMNS; c += 1) {
                if (c < 2) row.push(rnd.chance(0.8) ? constant(rnd.int(50)) : null);
                else row.push(rnd.chance(0.6) ? { f: formulaFor(rnd, names, level, c) } : null);
            }
            data.push(row);
        }
        return { id: `s${level + 1}`, name, order: level, row: ROWS, column: COLUMNS, data, config: {} };
    });
}

// Every formula computed in order from a graph built from the text alone: what the workbook holds if nothing was
// left stale.
export function fresh(sheets: readonly Sheet[]): Sheet[] {
    const materialized = sheets.map(withMaterializedData);
    const seeds = { cells: [], lines: [], reads: () => true };
    return recomputeAfter(materialized, seeds, new FormulaGraph(materialized), new FormulaEngine());
}

export const sizeOf = (sheet: Sheet) => ({ rows: sheet.data?.length ?? 0, columns: sheet.data?.[0]?.length ?? 0 });

export function rowColOp(rnd: Random, sheet: Sheet): Op {
    const type = rnd.chance(0.7) ? 'row' : 'column';
    const { rows, columns } = sizeOf(sheet);
    const size = type === 'row' ? rows : columns;
    if (size > 4 && (size > 18 || rnd.chance(0.5))) {
        const start = rnd.int(size - 2);
        return { op: 'deleteRowCol', id: sheet.id, path: [], value: { type, start, end: start + rnd.int(2) } };
    }
    const value = {
        type,
        index: rnd.int(size),
        count: 1 + rnd.int(2),
        direction: rnd.pick(['lefttop', 'rightbottom']),
    };
    return { op: 'insertRowCol', id: sheet.id, path: [], value };
}

// One to three cells written as their author's edit writes them: a constant, a formula or nothing.
export function cellOps(rnd: Random, sheets: readonly Sheet[]): Op[] {
    const ops: Op[] = [];
    for (let i = 0, n = 1 + rnd.int(3); i < n; i += 1) {
        const sheet = rnd.pick(sheets);
        const { rows, columns } = sizeOf(sheet);
        const r = rnd.int(rows);
        const c = rnd.int(columns);
        const level = LEVELS[sheet.id];
        const names = sheets.filter((s) => LEVELS[s.id] < level).map((s) => s.name);
        const kind = rnd.int(3);
        const value =
            kind === 0 || c === 0
                ? constant(rnd.int(50))
                : kind === 1
                  ? { f: formulaFor(rnd, names, names.length, c) }
                  : null;
        ops.push({ op: 'replace', id: sheet.id, path: ['data', r, c], value });
    }
    return ops;
}

// The values an edit's author computes go with its cells, so a batch of cell writes carries every value it changes.
export function withAuthorValues(sheets: Sheet[], ops: Op[]): Op[] {
    const after = replaySheetsOps(sheets, [ops]);
    const computed = fresh(after);
    const values: Op[] = [];
    for (const [i, sheet] of computed.entries()) {
        for (const [r, row] of (sheet.data ?? []).entries()) {
            for (const [c, cell] of (row ?? []).entries()) {
                const before = after[i].data?.[r]?.[c];
                if (cell?.f && cell.v !== before?.v) {
                    values.push({ op: 'replace', id: sheet.id, path: ['data', r, c], value: cell });
                }
            }
        }
    }
    return [...ops, ...values];
}

// The next batch a peer or an undo step could send on `sheets`.
export function nextBatch(rnd: Random, sheets: Sheet[], step: number): Op[] {
    const roll = rnd.int(20);
    const byId = (id: string) => sheets.find((s) => s.id === id);
    // A delete carries the orders it moved, as its author sends them, so the tab strip has no gap.
    const deleted = (id: string): Op[] => {
        const order = byId(id)?.order ?? 0;
        const after = sheets.filter((s) => (s.order ?? 0) > order);
        const orders = after.map((s): Op => ({ op: 'replace', id: s.id, path: ['order'], value: (s.order ?? 0) - 1 }));
        return [{ op: 'deleteSheet', id, path: [] }, ...orders];
    };
    if (roll === 0 && byId('s2')) {
        const name = byId('s2')?.name === 'Two' ? 'Second sheet' : 'Two';
        return [{ op: 'renameSheet', id: 's2', path: [], value: { name } }];
    }
    if (roll === 1 && !byId('s4')) {
        const level = LEVELS.s4;
        const names = sheets.filter((s) => LEVELS[s.id] < level).map((s) => s.name);
        const data = [0, 1, 2].map(() => [
            constant(rnd.int(50)),
            constant(rnd.int(50)),
            { f: formulaFor(rnd, names, names.length, 2) },
        ]);
        // A sheet arrives with its values, as a duplicate or an imported tab does.
        const added: Sheet = { id: 's4', name: 'Extra', order: sheets.length, row: 3, column: 3, data, config: {} };
        const [value] = fresh([...sheets, added]).slice(-1);
        return [{ op: 'addSheet', path: [], value }];
    }
    if (roll === 2 && byId('s4')) return deleted('s4');
    if (roll === 3 && byId('s3') && step > 20) return deleted('s3');
    if (roll < 9) return withAuthorValues(sheets, cellOps(rnd, sheets));
    const ops = [rowColOp(rnd, rnd.pick(sheets))];
    // A structural undo or redo can send several row or column ops at once.
    if (rnd.chance(0.15)) ops.push(rowColOp(rnd, rnd.pick(sheets)));
    // A hostile peer's batch can fail after its row op shifted the graph, and every reader skips it whole.
    if (rnd.chance(0.1)) return [...ops, { op: 'insertRowCol', id: ops[0].id, path: [], value: { type: 'row' } }];
    // An undo's repairs write cells beside its row op, with their values.
    if (rnd.chance(0.2)) {
        return withAuthorValues(sheets, [...ops, ...cellOps(rnd, replaySheetsOps(sheets, [ops]))]);
    }
    return ops;
}

// Formulas on a loop, written to `sheet` as an edit writes them: a cell that reads itself, two or three cells that read
// each other in a ring, or a cell inside the range it sums, and at times a cell that reads the loop from outside.
function loopOps(rnd: Random, sheet: Sheet): Op[] {
    const { rows, columns } = sizeOf(sheet);
    const at = () => ({ r: rnd.int(rows), c: rnd.int(columns) });
    const name = ({ r, c }: { r: number; c: number }) => `${letter(c)}${r + 1}`;
    const write = ({ r, c }: { r: number; c: number }, f: string): Op => ({
        op: 'replace',
        id: sheet.id,
        path: ['data', r, c],
        value: { f },
    });
    const ring = [at(), at(), at()].slice(0, 1 + rnd.int(3));
    const [first] = ring;
    const top = Math.max(0, first.r - rnd.int(3));
    const ops = rnd.chance(0.25)
        ? [write(first, `=SUM(${letter(first.c)}${top + 1}:${letter(first.c)}${top + 3})`)]
        : ring.map((cell, i) => write(cell, `=${name(ring[(i + 1) % ring.length])}+1`));
    if (rnd.chance(0.6)) ops.splice(rnd.int(ops.length + 1), 0, write(at(), `=${name(first)}*2`));
    return ops;
}

// A row or column op on the line of one of the workbook's formulas or a line beside it, or null when it holds none.
// On the line a delete breaks the formula's loop, and before it an op moves the loop.
function rowColOpAtFormula(rnd: Random, sheets: readonly Sheet[]): Op | null {
    const formulas = sheets.flatMap((sheet) =>
        (sheet.data ?? []).flatMap((row, r) => (row ?? []).flatMap((cell, c) => (cell?.f ? [{ sheet, r, c }] : []))),
    );
    if (formulas.length === 0) return null;
    const { sheet, r, c } = rnd.pick(formulas);
    const type = rnd.chance(0.7) ? 'row' : 'column';
    const { rows, columns } = sizeOf(sheet);
    const size = type === 'row' ? rows : columns;
    const line = Math.min(size - 1, Math.max(0, (type === 'row' ? r : c) + rnd.int(3) - 1));
    if (size > 4 && (size > 14 || rnd.chance(0.5))) {
        return { op: 'deleteRowCol', id: sheet.id, path: [], value: { type, start: line, end: line } };
    }
    const value = { type, index: line, count: 1, direction: rnd.pick(['lefttop', 'rightbottom']) };
    return { op: 'insertRowCol', id: sheet.id, path: [], value };
}

// The next batch on a workbook whose formulas may read themselves: a loop typed in, a row or column op at a formula,
// or such an op with the loop its undo writes back, which is how a row op creates one.
export function nextLoopBatch(rnd: Random, sheets: Sheet[]): Op[] {
    const op = rnd.chance(0.6) ? rowColOpAtFormula(rnd, sheets) : null;
    if (!op) return withAuthorValues(sheets, loopOps(rnd, rnd.pick(sheets)));
    if (rnd.chance(0.7)) return [op];
    const moved = replaySheetsOps(sheets, [[op]]).find((sheet) => sheet.id === op.id);
    return moved ? withAuthorValues(sheets, [op, ...loopOps(rnd, moved)]) : [op];
}

// A batch every reader skips, because one of its ops is malformed.
export const malformed = (batch: readonly Op[]) =>
    batch.some(({ op, value }) => op === 'insertRowCol' && isRecord(value) && value['count'] == null);
