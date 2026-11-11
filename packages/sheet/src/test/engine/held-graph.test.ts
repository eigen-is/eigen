import { describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { FormulaGraph } from '../../engine/formula-graph';
import { replaySheetsOps, SkippedRecompute, withMaterializedData } from '../../engine/replay-ops';
import type { Context } from '../../state/context';
import { applyOpBatch } from '../../state/modules/apply-ops';
import { heldGraph, selectionFactory, workbookContextFactory } from '../state/factories/context';
import { fresh, letter, malformed, nextBatch, random, workbook } from '../state/factories/workbook-fuzz';

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

function editor(sheets: readonly Sheet[]): Context {
    const ctx = workbookContextFactory({
        currentSheetId: 's1',
        selections: selectionFactory([0, 0], [0, 0], 0, 0),
        sheets: sheets.map(withMaterializedData),
    });
    const frozen = produce(ctx, () => {});
    heldGraph(frozen);
    return frozen;
}

describe('a held formula graph', () => {
    for (const seed of Array.from({ length: 16 }, (_, i) => i + 1)) {
        test(`seed ${seed}: after every batch the graph reaches what a fresh one does, and the values are fresh`, () => {
            const rnd = random(seed);
            const start = fresh(workbook(rnd));
            const batches: Op[][] = [];
            let ctx = editor(start);
            let sheets = start;
            for (let step = 0; step < 40; step += 1) {
                const batch = nextBatch(rnd, sheets, step);
                batches.push(batch);
                const where = `seed ${seed}, batch ${step}: ${JSON.stringify(batch).slice(0, 300)}`;

                let dropped = 0;
                sheets = replaySheetsOps(start, batches, () => {
                    dropped += 1;
                });
                expect({ where, dropped }).toEqual({ where, dropped: batches.filter(malformed).length });
                expect(differences(`${where}\n  replay`, sheets, fresh(sheets))).toEqual([]);

                const applied = applyOpBatch(ctx, batch);
                expect({ where, skipped: applied == null }).toEqual({ where, skipped: malformed(batch) });
                ctx = applied?.ctx ?? ctx;
                expect(differences(`${where}\n  editor`, ctx.sheets, sheets)).toEqual([]);
                const held = heldGraph(ctx);
                expect({ where, reach: reach(held, ctx.sheets) }).toEqual({
                    where,
                    reach: reach(new FormulaGraph(ctx.sheets), ctx.sheets),
                });
            }
        });
    }
});

// The slots a workbook here lists hover around this budget, so most seeds pass it at some batches and not at others.
const BUDGETS = { maxDependencySlots: 34 };

// A replay of one batch builds its graph for that batch, so the graph held across the batches must skip the same
// recomputes and compute the same values.
describe('a held formula graph under a budget', () => {
    for (const seed of Array.from({ length: 16 }, (_, i) => i + 1)) {
        test(`seed ${seed}: the replay skips the recomputes a graph built for each batch skips, and no other`, () => {
            const rnd = random(seed);
            const start = fresh(workbook(rnd));
            const batches: Op[][] = [];
            let sheets = start;
            let alone = start;
            let skippedAlone = 0;
            for (let step = 0; step < 40; step += 1) {
                const batch = nextBatch(rnd, sheets, step);
                batches.push(batch);
                const where = `seed ${seed}, batch ${step}: ${JSON.stringify(batch).slice(0, 300)}`;

                let skipped = 0;
                sheets = replaySheetsOps(
                    start,
                    batches,
                    (e) => {
                        if (e instanceof SkippedRecompute) skipped += 1;
                    },
                    BUDGETS,
                );
                alone = replaySheetsOps(
                    alone,
                    [batch],
                    (e) => {
                        if (e instanceof SkippedRecompute) skippedAlone += 1;
                    },
                    BUDGETS,
                );
                expect({ where, skipped }).toEqual({ where, skipped: skippedAlone });
                expect(differences(`${where}\n  replay`, sheets, alone)).toEqual([]);
            }
        });
    }
});
