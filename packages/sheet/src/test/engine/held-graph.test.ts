import { describe, expect, test } from 'bun:test';
import type { Cell, Op, Sheet } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { FormulaEngine } from '../../engine/formula-engine';
import { FormulaGraph } from '../../engine/formula-graph';
import { recomputeAfter } from '../../engine/recalc';
import { replaySheetsOps, withMaterializedData } from '../../engine/replay-ops';
import type { Context } from '../../state/context';
import { applyOpBatch } from '../../state/modules/apply-ops';
import { warmFormulaGraph } from '../../state/modules/formula-exec';
import { contextFactory, selectionFactory } from '../state/factories/context';

// A seeded generator, so a failure names the seed and batch that reproduce it.
function random(seed: number) {
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
type Random = ReturnType<typeof random>;

const ROWS = 9;
const COLUMNS = 6;
const letter = (c: number) => String.fromCharCode(65 + c);
const constant = (v: number): Cell => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });

// A formula on sheet `level` in column `column` reads only columns to its left on its own sheet, or any cell of a
// sheet of a lower level. A row or column op keeps that order, so the workbook stays free of cycles.
function formulaFor(rnd: Random, names: readonly string[], level: number, column: number): string {
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

function workbook(rnd: Random): Sheet[] {
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
function fresh(sheets: readonly Sheet[]): Sheet[] {
    const materialized = sheets.map(withMaterializedData);
    const seeds = { cells: [], lines: [], reads: () => true };
    return recomputeAfter(materialized, seeds, new FormulaGraph(materialized), new FormulaEngine());
}

// For every cell of every sheet, the formulas a change there reaches, by where they sit, and each formula's text.
function reach(graph: FormulaGraph, sheets: readonly Sheet[]): string[] {
    const name = ({ id, r, c }: { id: string; r: number; c: number }) =>
        `${sheets.find((s) => s.id === id)?.name}!${letter(c)}${r + 1}`;
    const lines = Object.values(graph.formulas).map((node) => `${name(node)} ${node.formula}`);
    for (const { id, data } of sheets) {
        for (const [r, row] of (data ?? []).entries()) {
            for (const c of (row ?? []).keys()) {
                const reached = graph.affected(sheets, [{ id, r, c }]).map(name).sort();
                if (reached.length > 0) lines.push(`${name({ id, r, c })} -> ${reached.join(' ')}`);
            }
        }
    }
    return lines.sort();
}

// Each formula cell's text and value, by sheet and cell.
function formulaValues(sheets: readonly Sheet[]): Map<string, string> {
    const values = new Map<string, string>();
    for (const sheet of sheets) {
        for (const [r, row] of (sheet.data ?? []).entries()) {
            for (const [c, cell] of (row ?? []).entries()) {
                if (cell?.f) values.set(`${sheet.name}!${letter(c)}${r + 1}`, `${cell.f} = ${String(cell.v)}`);
            }
        }
    }
    return values;
}

// The formula cells where `actual` holds another text or value than `expected`, each named with `where`.
function differences(where: string, actual: readonly Sheet[], expected: readonly Sheet[]): string[] {
    const got = formulaValues(actual);
    const want = formulaValues(expected);
    const cells = new Set([...got.keys(), ...want.keys()]);
    return [...cells].flatMap((cell) =>
        got.get(cell) === want.get(cell) ? [] : [`${where}\n  ${cell}: ${got.get(cell)}, not ${want.get(cell)}`],
    );
}

const sizeOf = (sheet: Sheet) => ({ rows: sheet.data?.length ?? 0, columns: sheet.data?.[0]?.length ?? 0 });

function rowColOp(rnd: Random, sheet: Sheet): Op {
    const type = rnd.chance(0.7) ? 'row' : 'column';
    const { rows, columns } = sizeOf(sheet);
    const size = type === 'row' ? rows : columns;
    if (size > 4 && (size > 14 || rnd.chance(0.5))) {
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
function cellOps(rnd: Random, sheets: readonly Sheet[]): Op[] {
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
function withAuthorValues(sheets: Sheet[], ops: Op[]): Op[] {
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

function nextBatch(rnd: Random, sheets: Sheet[], step: number): Op[] {
    const roll = rnd.int(20);
    const byId = (id: string) => sheets.find((s) => s.id === id);
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
        const added: Sheet = { id: 's4', name: 'Extra', order: sheets.length, data, config: {} };
        const [value] = fresh([...sheets, added]).slice(-1);
        return [{ op: 'addSheet', path: [], value }];
    }
    if (roll === 2 && byId('s4')) return [{ op: 'deleteSheet', id: 's4', path: [] }];
    if (roll === 3 && byId('s3') && step > 20) return [{ op: 'deleteSheet', id: 's3', path: [] }];
    if (roll < 9) return withAuthorValues(sheets, cellOps(rnd, sheets));
    const ops = [rowColOp(rnd, rnd.pick(sheets))];
    // A structural undo or redo can send several row or column ops at once.
    if (rnd.chance(0.15)) ops.push(rowColOp(rnd, rnd.pick(sheets)));
    // An undo's repairs write cells beside its row op, with their values.
    if (rnd.chance(0.2)) {
        return withAuthorValues(sheets, [...ops, ...cellOps(rnd, replaySheetsOps(sheets, [ops]))]);
    }
    return ops;
}

function editor(sheets: readonly Sheet[]): Context {
    const ctx = contextFactory({
        currentSheetId: 's1',
        selections: selectionFactory([0, 0], [0, 0], 0, 0),
        sheets: sheets.map(withMaterializedData),
    } as never) as Context;
    const frozen = produce(ctx, () => {});
    warmFormulaGraph(frozen);
    return frozen;
}

describe('a held formula graph', () => {
    for (const seed of Array.from({ length: 16 }, (_, i) => i + 1)) {
        test(`seed ${seed}: every batch leaves the values a fresh recalc computes`, () => {
            const rnd = random(seed);
            const start = fresh(workbook(rnd));
            const batches: Op[][] = [];
            let ctx = editor(start);
            let sheets = start;
            for (let step = 0; step < 40; step += 1) {
                const batch = nextBatch(rnd, sheets, step);
                batches.push(batch);
                const where = `seed ${seed}, batch ${step}: ${JSON.stringify(batch).slice(0, 300)}`;

                sheets = replaySheetsOps(start, batches, (e) => {
                    throw new Error(`${where} failed: ${String(e)}`);
                });
                expect(differences(`${where}\n  replay`, sheets, fresh(sheets))).toEqual([]);

                const applied = applyOpBatch(ctx, batch);
                if (applied == null) throw new Error(`${where} failed in the editor`);
                ctx = applied.ctx;
                expect(differences(`${where}\n  editor`, ctx.sheets, sheets)).toEqual([]);
                const held = warmFormulaGraph(ctx);
                expect({ where, reach: reach(held, ctx.sheets) }).toEqual({
                    where,
                    reach: reach(new FormulaGraph(ctx.sheets), ctx.sheets),
                });
            }
        });
    }
});
