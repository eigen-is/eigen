import { expect, test } from 'bun:test';
import type { Cell, Op, Sheet } from '@workspace/lib/sheets';
import { FormulaEngine } from '../../engine/formula-engine';
import { FormulaGraph } from '../../engine/formula-graph';
import { recomputeAfter } from '../../engine/recalc';
import { replaySheetsOps, SkippedRecompute, withMaterializedData } from '../../engine/replay-ops';

const n = (v: number): Cell => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' } });

function fresh(sheets: readonly Sheet[]): Sheet[] {
    const materialized = sheets.map(withMaterializedData);
    const seeds = { cells: [], lines: [], reads: () => true };
    return recomputeAfter(materialized, seeds, new FormulaGraph(materialized), new FormulaEngine());
}

// The graph is built while One has 60 rows, where each SUM(One!A:A) lists one block. One then grows to 130 rows, and
// listing the cut ranges again at 3 slots each passes the budget of 4 partway. A cell batch then takes two SUMs away,
// which brings a graph that kept going back under the budget, and the last batch deletes the row the cell batch wrote.
test('a recompute past the slot budget is reported, and the next one builds a whole graph', () => {
    const one: Sheet = {
        id: 's1',
        name: 'One',
        order: 0,
        data: Array.from({ length: 60 }, (_, r) => [n(r === 0 ? 1 : 0)]),
        config: {},
    };
    const sum = { f: '=SUM(One!A:A)', v: 1 };
    const two: Sheet = { id: 's2', name: 'Two', order: 1, data: [[sum], [sum], [sum]], config: {} };
    const insert = (id: string, index: number, count: number): Op => ({
        op: 'insertRowCol',
        id,
        path: [],
        value: { type: 'row', index, count, direction: 'rightbottom' },
    });
    const batches: Op[][] = [
        [insert('s2', 2, 1)],
        [insert('s1', 59, 70)],
        [
            { op: 'replace', id: 's2', path: ['data', 0, 0], value: null },
            { op: 'replace', id: 's1', path: ['data', 100, 0], value: n(5) },
            { op: 'replace', id: 's2', path: ['data', 1, 0], value: null },
            { op: 'replace', id: 's2', path: ['data', 2, 0], value: { f: '=SUM(One!A:A)', v: 6 } },
        ],
        [{ op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 100, end: 100 } }],
    ];
    const reported: unknown[] = [];
    const replayed = replaySheetsOps([one, two], batches, (e) => reported.push(e), { maxDependencySlots: 4 });
    const values = (sheets: Sheet[]) => sheets[1].data?.map((row) => row?.[0]?.v ?? null);
    expect(values(replayed)).toEqual(values(fresh(replayed)));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(SkippedRecompute);
});

// A batch that starts just before the fold's deadline must stop in the graph build or the walk, before it evaluates.
test('a graph build past the deadline stops at the next formula it lists', () => {
    const sheet = { id: 's1', name: 'One', data: [[{ f: '=1+1', v: 2 }], [{ f: '=A1*2', v: 4 }]] };
    expect(() => new FormulaGraph([sheet], { deadline: performance.now() - 1 })).toThrow(RangeError);
});

test('a walk past the deadline stops at the next cell it visits', async () => {
    const sheet = { id: 's1', name: 'One', data: [[n(1)], [n(2)]] };
    const graph = new FormulaGraph([sheet], { deadline: performance.now() + 5 });
    await Bun.sleep(10);
    expect(() => graph.affected([sheet], [{ id: 's1', r: 0, c: 0 }])).toThrow(RangeError);
});
