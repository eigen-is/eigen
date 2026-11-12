// Recalc on demand. A pass flags the formulas that the cells written since the last one reach, then computes them.
// Reading a cell whose formula is still to be computed computes it first, so a formula always sees final values and
// no order is worked out ahead. A cell met while it is being computed is on a loop, with every cell that was reading
// towards it, and all of them get the loop's result whatever they computed. Nesting is bounded by one budget: past
// it the calls in progress are dropped by a throw and the cells computed again from the list of cells in progress.

import { Evaluator } from '../eval/evaluator';
import { FACT_BITS, Fact, shapeFacts } from '../eval/facts';
import type { Registry } from '../functions/registry';
import type { Column } from '../store/column';
import { DIRTY, KIND_MASK, LOOP, RUNNING, SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { ERROR, REF } from '../values/errors';
import type { Reference, Scalar } from '../values/value';
import { ReverseIndex } from './reverse-index';

export type CellAddress = { readonly sheet: string; readonly row: number; readonly column: number };

export type RecalcResult = {
    // Every cell of the workbook that is on a circular reference, in sheet, column, row order. Final only when
    // `stopped` is false: a pass that stopped can still list a loop that a write broke, until a later one computes it.
    readonly loops: readonly CellAddress[];
    // True when the pass met its cap with formulas still to compute. What it computed stays, and the next goes on.
    readonly stopped: boolean;
};

// How much of the stack the cells in progress may take together before their calls are dropped, in the units of a
// shape's depth: half of the smallest stack the engine runs on. Reading a cell takes CELL on top of its shape.
const BUDGET = 640;
const CELL = 6;

// The most elements one array stores, which bounds memory, and the most work one formula does, which bounds time: the
// elements of its arrays, the characters of the texts it made for them, and the numbers it adds one by one for
// cells that no array stores. A formula that needs more of either is #CALC!, alone.
const MOST_STORED = 2 ** 24;
const MOST_WORK = 2 ** 27;

const UNWIND = Object.freeze({ reason: 'the evaluation nests too deep' });
const STOP = Object.freeze({ reason: 'the recalc computed as many formulas as its cap' });

export class Recalc {
    private readonly workbook: Workbook;
    private readonly functions: Registry;
    private readonly evaluator: Evaluator;
    private readonly index = new ReverseIndex();
    // Whether a formula came or went since the index was built.
    private stale = true;
    // The spans of rows written since the last pass: sheet, column, first and last row.
    private readonly seeds: number[] = [];
    // Per shape id, its facts.
    private readonly facts: number[] = [];
    // The cells in progress, in the order they were entered. The list is the reading chain, each cell read by the
    // one before it on the chain, plus the cells whose formula ran and that wait for the first cell of their loop.
    private readonly sheets: Sheet[] = [];
    private readonly columns: Column[] = [];
    // The place of each cell's column in its sheet.
    private readonly places: number[] = [];
    private readonly rows: number[] = [];
    // The cell whose formula was reading when this one was entered, or -1.
    private readonly parents: number[] = [];
    // A cell of the list this one is on a loop with, at or before it, and itself while it is on none. It can lag
    // behind the loop's first cell, but `lows[i] < i` exactly when cell i waits on an earlier cell in progress.
    private readonly lows: number[] = [];
    // Where in the list a cell that is on a loop sits, which the chain alone does not tell once its formula ran.
    private readonly looped = new Map<Column, Map<number, number>>();
    private size = 0;
    // The innermost cell whose formula is running, or -1.
    private current = -1;
    private depth = 0;
    // What the pass has cost so far, in formulas computed and array elements made, and how much it may.
    private cost = 0;
    private cap = 0;
    // Whether the pass has stored a formula yet.
    private stored = false;
    // What each cell in progress has made since its formula last started.
    private readonly made: number[] = [];
    // The area each cell in progress is having computed, which a throw for depth leaves for the pass, or null.
    private readonly areas: (Reference | null)[] = [];

    public constructor(workbook: Workbook, functions: Registry) {
        this.workbook = workbook;
        this.functions = functions;
        this.evaluator = new Evaluator(workbook, functions, this);
        // A formula that came without a value was never computed, which the ones that came with a value have to hear.
        for (let s = 0; s < workbook.sheets.length; s += 1) {
            const { columns } = workbook.sheets[s];
            for (let c = 0; c < columns.length; c += 1) {
                const { kind, length } = columns[c];
                for (let row = 0; columns[c].pending > 0 && row < length; row += 1) {
                    if (kind[row] > SETTLED) this.seed(s, c, row);
                }
            }
        }
    }

    // To be called before a cell is written, with whether a formula is: the cell is a seed of the next pass.
    public touch(sheet: Sheet, row: number, c: number, formula: boolean): void {
        const column = sheet.columns[c];
        if (formula || (column !== undefined && column.shape[row] > 0)) this.stale = true;
        this.seed(this.workbook.sheets.indexOf(sheet), c, row);
    }

    // Computes the formulas that the cells written since the last pass reach, those that read cells they do not
    // name, and what an earlier pass left, in sheet, column, row order where the reads do not ask for another.
    public pass(cap: number, now = 0, seed = 0): RecalcResult {
        const { workbook } = this;
        this.evaluator.clock(now, seed);
        if (this.stale) {
            for (let shape = 1; shape <= workbook.shapes.size; shape += 1) this.factsOf(shape);
            this.index.rebuild(workbook, this.facts);
            this.stale = false;
        }
        // A cell written twice is one seed: the spans in sheet, column and row order, those that meet as one.
        const { seeds } = this;
        const order: number[] = [];
        for (let at = 0; at < seeds.length; at += 4) order.push(at);
        order.sort((a, b) => seeds[a] - seeds[b] || seeds[a + 1] - seeds[b + 1] || seeds[a + 2] - seeds[b + 2]);
        const spans: number[] = [];
        for (const at of order) {
            const last = spans.length - 4;
            const sameColumn = last >= 0 && spans[last] === seeds[at] && spans[last + 1] === seeds[at + 1];
            if (sameColumn && spans[last + 3] >= seeds[at + 2] - 1) {
                spans[last + 3] = Math.max(spans[last + 3], seeds[at + 3]);
            } else spans.push(seeds[at], seeds[at + 1], seeds[at + 2], seeds[at + 3]);
        }
        this.index.mark(workbook, spans);
        seeds.length = 0;
        this.cost = 0;
        this.stored = false;
        this.cap = cap;
        let stopped = false;
        try {
            for (const sheet of workbook.sheets) {
                for (let c = 0; c < sheet.columns.length; c += 1) {
                    const column = sheet.columns[c];
                    for (let row = 0; column.pending > 0 && row < column.length; row += 1) {
                        if (column.kind[row] <= SETTLED) continue;
                        this.enter(sheet, column, c, row);
                        // After a throw for depth the innermost cell in progress goes first, with no call above it.
                        while (this.current >= 0) {
                            const at = this.current;
                            const area = this.areas[at];
                            this.evaluator.calls = 0;
                            try {
                                // The area it was reading is computed from here, with nothing of its formula on
                                // the stack: a formula too deep to read one cell starts again once, not per cell.
                                this.depth = 0;
                                if (area !== null) this.settleArea(area);
                                this.depth = this.nesting(this.columns[at].shape[this.rows[at]]);
                                this.compute();
                            } catch (thrown) {
                                if (thrown !== UNWIND) throw thrown;
                                // Every formula in progress runs again from its start, and makes its arrays again.
                                this.made.fill(0, 0, this.size);
                            }
                        }
                        if (this.looped.size > 0) this.looped.clear();
                    }
                }
            }
        } catch (thrown) {
            // The cells in progress are still to be computed, loops and all, whatever was thrown: the next pass
            // starts clean.
            for (let i = 0; i < this.size; i += 1) {
                const column = this.columns[i];
                const kind = column.kind[this.rows[i]];
                if (kind <= SETTLED) continue;
                column.setLoop(this.rows[i], false);
                column.kind[this.rows[i]] = (kind & KIND_MASK) | DIRTY;
            }
            this.size = 0;
            this.current = -1;
            this.looped.clear();
            if (thrown !== STOP) throw thrown;
            stopped = true;
        }
        const loops: CellAddress[] = [];
        for (const sheet of workbook.sheets) {
            for (let c = 0; c < sheet.columns.length; c += 1) {
                const { kind, length } = sheet.columns[c];
                for (let row = 0; sheet.columns[c].loops > 0 && row < length; row += 1) {
                    if (kind[row] & LOOP) loops.push({ sheet: sheet.id, row, column: c });
                }
            }
        }
        return { loops, stopped };
    }

    // The value of a cell that a formula in progress reads, its own formula computed first when it is still to be.
    public valueOf(sheet: Sheet, row: number, c: number): Scalar {
        const column = sheet.columns[c];
        if (column === undefined || row >= column.length) return null;
        if (column.kind[row] > SETTLED) this.resolve(sheet, column, c, row);
        return this.workbook.value(column, row);
    }

    // Computes what is still to be computed in one area, so a loop over its planes meets values only.
    public settleArea(area: Reference): void {
        const { top } = area;
        const reader = this.current;
        this.areas[reader] = area;
        const sheet = this.workbook.sheets[area.sheet];
        const right = Math.min(area.right, sheet.columns.length - 1);
        for (let c = area.left; c <= right; c += 1) {
            const column = sheet.columns[c];
            const end = Math.min(area.bottom + 1, column.length);
            for (let row = top; column.pending > 0 && row < end; row += 1) {
                if (column.kind[row] > SETTLED) this.resolve(sheet, column, c, row);
            }
        }
        this.areas[reader] = null;
    }

    // Asks for an array of so many stored elements before the running formula makes it: false when one array may
    // not store that many, or the formula may not do the work.
    public room(elements: number): boolean {
        return elements <= MOST_STORED && this.spend(elements);
    }

    // Asks for work the running formula is about to do, such as the characters of a text, before it does it: false
    // when the formula would then have done more than it may, and else it is added to what the pass costs.
    public spend(units: number): boolean {
        const made = this.made[this.current] + units;
        if (made > MOST_WORK) return false;
        this.made[this.current] = made;
        return true;
    }

    private seed(sheet: number, c: number, row: number): void {
        const { seeds } = this;
        const last = seeds.length - 4;
        // Cells written down one column are one span.
        if (last >= 0 && seeds[last] === sheet && seeds[last + 1] === c && seeds[last + 3] === row - 1) {
            seeds[last + 3] = row;
        } else seeds.push(sheet, c, row, row);
    }

    // Computes a cell that a formula in progress reads.
    private resolve(sheet: Sheet, column: Column, c: number, row: number): void {
        if (column.kind[row] & RUNNING) {
            this.close(column, row);
            return;
        }
        this.enter(sheet, column, c, row);
        const cost = this.nesting(column.shape[row]);
        this.depth += cost;
        if (this.depth > BUDGET) throw UNWIND;
        this.compute();
        this.depth -= cost;
    }

    private enter(sheet: Sheet, column: Column, c: number, row: number): void {
        const at = this.size;
        // Whether the cell is on a loop is found out again.
        column.setLoop(row, false);
        column.kind[row] |= RUNNING;
        this.sheets[at] = sheet;
        this.columns[at] = column;
        this.places[at] = c;
        this.rows[at] = row;
        this.parents[at] = this.current;
        this.lows[at] = at;
        this.made[at] = 0;
        this.areas[at] = null;
        this.size = at + 1;
        this.current = at;
    }

    // The running formula read a cell in progress, so the two are on a loop, with every cell that was reading
    // between them. Each holds the loop's result from here on, so whoever reads one reads that.
    private close(column: Column, row: number): void {
        let found = this.looped.get(column)?.get(row);
        if (found === undefined) {
            // A cell on no loop yet is on the chain above the running one, and no loop on the way up holds it: so
            // each cell that is not it is skipped with its loop, down to its low, and the search goes on at the reader.
            found = this.current;
            while (this.columns[found] !== column || this.rows[found] !== row) found = this.parents[this.lows[found]];
        }
        const from = this.lows[found];
        let at = this.current;
        while (at >= from) {
            const low = this.lows[at];
            const joined = this.columns[at];
            const known = (joined.kind[this.rows[at]] & LOOP) !== 0;
            // A loop that goes up to `from` or past it holds every cell of the chain still to come.
            if (known && low <= from) break;
            if (known && low < at) {
                // The readers down to `low` are on that loop already: only its first cell joins this one.
                at = low;
                continue;
            }
            if (!known) {
                joined.setLoop(this.rows[at], true);
                this.workbook.put(joined, this.rows[at], REF);
                let rows = this.looped.get(joined);
                if (rows === undefined) this.looped.set(joined, (rows = new Map()));
                rows.set(this.rows[at], at);
            }
            this.lows[at] = from;
            at = this.parents[at];
        }
    }

    // Computes the innermost cell in progress and stores its result. A throw leaves it in progress, with nothing
    // stored.
    private compute(): void {
        const at = this.current;
        const column = this.columns[at];
        const row = this.rows[at];
        const shape = column.shape[row];
        const kept = (this.factsOf(shape) & Fact.Kept) !== 0;
        const { tree } = this.workbook.shapes.shape(shape);
        const value = kept
            ? null
            : tree === null
              ? ERROR
              : this.evaluator.result(tree, this.sheets[at], row, this.places[at]);
        this.current = this.parents[at];
        // On a loop that an earlier cell has still to close: it stays in the list for whoever reads it.
        if (this.lows[at] < at) return;
        // The cap is met before a formula is stored, never inside a loop that is being stored, and a pass never
        // stops before its first store: a formula that costs more than the cap alone would hold every pass up.
        if (this.cost >= this.cap && this.stored) throw STOP;
        this.stored = true;
        if ((column.kind[row] & LOOP) === 0 && !kept) this.workbook.put(column, row, value);
        for (let i = at; i < this.size; i += 1) {
            this.cost += 1 + this.made[i];
            this.columns[i].computed(this.rows[i]);
        }
        this.size = at;
    }

    // What one cell of a shape adds to the nesting.
    private nesting(shape: number): number {
        return (this.factsOf(shape) >> FACT_BITS) + CELL;
    }

    public factsOf(shape: number): number {
        let facts = this.facts[shape];
        if (facts === undefined) {
            const { tree } = this.workbook.shapes.shape(shape);
            facts = tree === null ? 1 << FACT_BITS : shapeFacts(tree, this.functions);
            this.facts[shape] = facts;
        }
        return facts;
    }
}
