// Recalc on demand. A pass flags the formulas that the cells written since the last one reach, then computes them.
// Reading a cell whose formula is still to be computed computes it first, so a formula always sees final values and
// no order is worked out ahead. A cell met while it is being computed is on a loop, with every cell that was reading
// towards it, and all of them get the loop's result whatever they computed. Nesting is bounded by one budget: past
// it the calls in progress are dropped by a throw and the cells computed again from the list of cells in progress.

import type { Evaluator as EvaluatorType } from '../eval/evaluator';
import { Evaluator } from '../eval/evaluator';
import { FACT_BITS, Fact, shapeFacts } from '../eval/facts';
import type { Registry } from '../functions/registry';
import type { Column } from '../store/column';
import { KIND_MASK, LOOP, RUNNING } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { ERROR, REF } from '../values/errors';
import type { Reference, Scalar } from '../values/value';
import { ReverseIndex } from './reverse-index';

export type CellAddress = { readonly sheet: string; readonly row: number; readonly column: number };

export type RecalcResult = {
    // The cells this pass found on a circular reference.
    readonly loops: readonly CellAddress[];
    // True when the pass read more cells than its cap: the store is as it was before the pass.
    readonly abandoned: boolean;
};

// How deep cells and tree nodes may nest, together, before the calls in progress are dropped: well under half of
// what the smallest default stack measured holds, since a worker's stack is smaller.
const BUDGET = 400;

const UNWIND = Object.freeze({ reason: 'the evaluation nests too deep' });
const ABANDON = Object.freeze({ reason: 'the recalc read more cells than its cap' });

export class Recalc {
    private readonly workbook: Workbook;
    private readonly functions: Registry;
    private readonly evaluator: EvaluatorType;
    private readonly index = new ReverseIndex();
    // Whether a formula came or went since the index was built.
    private stale = true;
    // The spans of rows written since the last pass that was not abandoned: sheet, column, first and last row.
    private readonly seeds: number[] = [];
    // Per shape id, its facts, learned when a cell of the shape is first computed.
    private readonly facts: number[] = [];
    // The cells in progress, in the order they were entered. One stays here after its formula ran when it is on a
    // loop that an earlier cell has still to close.
    private readonly sheets: Sheet[] = [];
    private readonly helds: Column[] = [];
    private readonly columns: number[] = [];
    private readonly rows: number[] = [];
    // The cell whose formula was reading when this one was entered, or -1.
    private readonly parents: number[] = [];
    // The earliest cell in progress this one is on a loop with: itself while it is on none.
    private readonly lows: number[] = [];
    // Where in the list a cell on a loop sits.
    private readonly looped = new Map<Column, Map<number, number>>();
    private size = 0;
    // The innermost cell whose formula is running, or -1.
    private current = -1;
    private depth = 0;
    private reads = 0;
    private cap = Number.POSITIVE_INFINITY;
    private loops: CellAddress[] = [];
    // During a pass, what every cell it changed held before, so that an abandoned pass can put it back.
    private before: { column: Column; row: number; value: Scalar }[] | null = null;

    public constructor(workbook: Workbook, functions: Registry) {
        this.workbook = workbook;
        this.functions = functions;
        this.evaluator = new Evaluator(workbook, functions, this);
        // A formula that came without a value was never computed, which its readers have to hear.
        for (let s = 0; s < workbook.sheets.length; s += 1) {
            const { columns } = workbook.sheets[s];
            for (let c = 0; c < columns.length; c += 1) {
                const { kind, length } = columns[c];
                for (let row = 0; columns[c].pending > 0 && row < length; row += 1) {
                    if (kind[row] > KIND_MASK) this.seed(s, c, row);
                }
            }
        }
    }

    // To be called before a cell is written, with whether a formula is: the cell is a seed of the next pass.
    public touch(sheet: Sheet, row: number, column: number, formula: boolean): void {
        const held = sheet.columns[column];
        if (formula || (held !== undefined && held.shape[row] > 0)) this.stale = true;
        this.seed(this.workbook.sheets.indexOf(sheet), column, row);
    }

    // Computes the formulas that the cells written since the last pass reach, and those that read cells they do
    // not name, in sheet, column, row order where the reads do not ask for another.
    public pass(cap: number): RecalcResult {
        const { seeds, workbook } = this;
        if (this.stale) {
            for (let shape = 1; shape <= workbook.shapes.size; shape += 1) this.factsOf(shape);
            this.index.rebuild(workbook, this.facts);
            this.stale = false;
        }
        this.index.mark(workbook, seeds);
        this.loops = [];
        this.reads = 0;
        this.cap = cap;
        this.before = [];
        try {
            for (const sheet of this.workbook.sheets) {
                for (let c = 0; c < sheet.columns.length; c += 1) {
                    const column = sheet.columns[c];
                    for (let row = 0; column.pending > 0 && row < column.length; row += 1) {
                        if (column.kind[row] > KIND_MASK) this.demand(sheet, column, c, row);
                    }
                }
            }
            seeds.length = 0;
            return { loops: this.loops, abandoned: false };
        } catch (thrown) {
            if (thrown !== ABANDON) throw thrown;
            for (const { column, row, value } of this.before.reverse()) this.workbook.put(column, row, value);
            for (const sheet of this.workbook.sheets) {
                for (const column of sheet.columns) {
                    for (let row = 0; column.pending > 0 && row < column.length; row += 1) column.settle(row);
                }
            }
            // What the pass flagged is flagged again by the next one, from the same seeds. A formula among them
            // was written or never computed: it is still to be computed.
            for (let i = 0; i < seeds.length; i += 4) {
                const held = workbook.sheets[seeds[i]].columns[seeds[i + 1]];
                if (held === undefined) continue;
                const end = Math.min(seeds[i + 3] + 1, held.length);
                for (let row = seeds[i + 2]; row < end; row += 1) {
                    if (held.shape[row] !== 0) held.markDirty(row);
                }
            }
            this.size = 0;
            this.current = -1;
            this.looped.clear();
            return { loops: [], abandoned: true };
        } finally {
            this.cap = Number.POSITIVE_INFINITY;
            this.before = null;
        }
    }

    // The value of a cell, its formula computed first when it is still to be.
    public valueOf(sheet: Sheet, column: number, row: number): Scalar {
        const held = sheet.columns[column];
        if (held === undefined || row >= held.length) return null;
        if (held.kind[row] > KIND_MASK) {
            if (this.current < 0) this.demand(sheet, held, column, row);
            else this.settle(sheet, held, column, row);
        }
        this.count(1);
        return this.workbook.value(held, row);
    }

    // Computes what is still to be computed in one area, so a loop over its planes meets values only.
    public settleArea(area: Reference): void {
        const { sheet, top } = area;
        const right = Math.min(area.right, sheet.columns.length - 1);
        let cells = 0;
        for (let c = area.left; c <= right; c += 1) {
            const held = sheet.columns[c];
            const end = Math.min(area.bottom + 1, held.length);
            if (end > top) cells += end - top;
            for (let row = top; held.pending > 0 && row < end; row += 1) {
                if (held.kind[row] > KIND_MASK) this.settle(sheet, held, c, row);
            }
        }
        this.count(cells);
    }

    private seed(sheet: number, column: number, row: number): void {
        const { seeds } = this;
        const last = seeds.length - 4;
        // Cells written down one column are one span.
        if (last >= 0 && seeds[last] === sheet && seeds[last + 1] === column && seeds[last + 3] === row - 1) {
            seeds[last + 3] = row;
        } else seeds.push(sheet, column, row, row);
    }

    private count(cells: number): void {
        this.reads += cells;
        if (this.reads > this.cap) throw ABANDON;
    }

    // Computes one cell from outside any evaluation, however deep its precedents nest.
    private demand(sheet: Sheet, held: Column, column: number, row: number): void {
        this.enter(sheet, held, column, row);
        while (this.current >= 0) {
            this.depth = 0;
            this.evaluator.calls = 0;
            try {
                this.compute();
            } catch (thrown) {
                if (thrown !== UNWIND) throw thrown;
            }
        }
        this.looped.clear();
    }

    // Computes a cell that a formula in progress reads.
    private settle(sheet: Sheet, held: Column, column: number, row: number): void {
        if (held.kind[row] & RUNNING) {
            this.close(held, row);
            return;
        }
        this.enter(sheet, held, column, row);
        const cost = this.factsOf(held.shape[row]) >> FACT_BITS;
        this.depth += cost;
        if (this.depth > BUDGET) throw UNWIND;
        this.compute();
        this.depth -= cost;
    }

    private enter(sheet: Sheet, held: Column, column: number, row: number): void {
        const at = this.size;
        held.kind[row] |= RUNNING;
        this.sheets[at] = sheet;
        this.helds[at] = held;
        this.columns[at] = column;
        this.rows[at] = row;
        this.parents[at] = this.current;
        this.lows[at] = at;
        this.size = at + 1;
        this.current = at;
    }

    // The running formula read a cell in progress, so the two are on a loop, with every cell that was reading
    // between them. Each holds the loop's result from here on, so whoever reads one reads that.
    private close(held: Column, row: number): void {
        let found = this.looped.get(held)?.get(row);
        if (found === undefined) {
            // A cell that is on no loop yet is still running, so one of the readers above it leads back to it.
            found = this.current;
            while (this.helds[found] !== held || this.rows[found] !== row) found = this.parents[this.lows[found]];
        }
        const from = this.lows[found];
        let at = this.current;
        while (at >= from) {
            const low = this.lows[at];
            const known = (this.helds[at].kind[this.rows[at]] & LOOP) !== 0;
            if (known && low <= from) break;
            if (known && low < at) {
                // The readers down to `low` are on that loop already: only its first cell joins this one.
                at = low;
                continue;
            }
            const looped = this.helds[at];
            looped.kind[this.rows[at]] |= LOOP;
            this.store(looped, this.rows[at], REF);
            let rows = this.looped.get(looped);
            if (rows === undefined) this.looped.set(looped, (rows = new Map()));
            rows.set(this.rows[at], at);
            this.lows[at] = from;
            at = this.parents[at];
        }
    }

    // Computes the innermost cell in progress and stores its result. A throw leaves it in progress, with nothing
    // stored.
    private compute(): void {
        const at = this.current;
        const sheet = this.sheets[at];
        const held = this.helds[at];
        const row = this.rows[at];
        const shape = held.shape[row];
        const kept = (this.factsOf(shape) & Fact.Kept) !== 0;
        const { tree } = this.workbook.shapes.shape(shape);
        const value = kept ? null : tree === null ? ERROR : this.evaluator.result(tree, sheet, row, this.columns[at]);
        this.current = this.parents[at];
        // On a loop that an earlier cell has still to close: it stays in progress for whoever reads it.
        if (this.lows[at] < at) return;
        if ((held.kind[row] & LOOP) === 0 && !kept) this.store(held, row, value);
        for (let i = this.size - 1; i >= at; i -= 1) {
            const done = this.helds[i];
            if (done.kind[this.rows[i]] & LOOP) {
                this.loops.push({ sheet: this.sheets[i].id, row: this.rows[i], column: this.columns[i] });
            }
            done.settle(this.rows[i]);
        }
        this.size = at;
    }

    private store(held: Column, row: number, value: Scalar): void {
        const old = this.before === null ? null : this.workbook.value(held, row);
        if (this.workbook.put(held, row, value)) this.before?.push({ column: held, row, value: old });
    }

    private factsOf(shape: number): number {
        let facts = this.facts[shape];
        if (facts === undefined) {
            const { tree } = this.workbook.shapes.shape(shape);
            facts = tree === null ? 1 << FACT_BITS : shapeFacts(tree, this.functions);
            this.facts[shape] = facts;
        }
        return facts;
    }
}
