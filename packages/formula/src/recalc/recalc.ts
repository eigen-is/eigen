// Recalc on demand. Every write and structural edit goes through here, as one body that first notes or flags what
// is to be computed and then changes the store. A pass flags the formulas the written cells reach and computes
// them: reading a cell still to be computed computes it first, so no order is worked out ahead. A cell met while it
// is being computed is on a loop with every cell reading towards it. Nesting has one budget: past it the calls in
// progress are dropped by a throw and the cells computed again from the list of cells in progress.

import { Evaluator } from '../eval/evaluator';
import { FACT_BITS, Fact, shapeFacts } from '../eval/facts';
import type { Registry } from '../functions/registry';
import type { Column } from '../store/column';
import { DIRTY, KIND_MASK, LOOP, RUNNING, SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Change, Literal, SheetSource, Workbook } from '../store/workbook';
import { ChangeKind } from '../store/workbook';
import { ERROR, REF } from '../values/errors';
import type { Reference, Scalar } from '../values/value';
import type { Rewrite } from './edit-plan';
import { planEdit } from './edit-plan';
import { ReverseIndex } from './reverse-index';

type CellAddress = { readonly sheet: string; readonly row: number; readonly column: number };

export type RecalcResult = {
    // Every cell of the workbook that is on a circular reference, in sheet, column, row order. Final only when
    // `stopped` is false: a pass that stopped can still list a loop that a write broke, until a later one computes it.
    // A loop is found by computing it and by nothing else, as what a formula reads can hang on values: so the cells
    // of a loop that came from a load with values are listed once one of them is computed, and not before.
    readonly loops: readonly CellAddress[];
    // True when the pass met its cap with formulas still to compute. What it computed stays, and the next goes on.
    readonly stopped: boolean;
    // The cells whose value the pass changed, as runs down a column: the place of the sheet, the column, the
    // first and the last row. They are true until the next edit or pass. A pass that stopped can list a cell of
    // a loop that is still to be computed.
    readonly changed: readonly number[];
};

export type EditResult = {
    readonly rewrites: readonly Rewrite[];
    // How many cells that held a value or a formula the edit pushed off the grid, which are gone.
    readonly dropped: number;
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
    // Whether a formula came, went or moved since the index was built.
    private stale = true;
    // The spans of rows written since the last pass or edit: sheet, column, first and last row.
    private readonly seeds: number[] = [];
    // The runs of cells whose value the pass changed.
    private changed: number[] = [];
    // Per shape id, its facts, or -1 until they are worked out: the shape table's own list.
    private readonly facts: number[];
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
        this.facts = workbook.shapes.facts;
        this.evaluator = new Evaluator(workbook, functions, this);
        // A formula that came without a value was never computed, which the ones that came with a value have to hear.
        for (let s = 0; s < workbook.sheets.length; s += 1) {
            const { columns } = workbook.sheets[s];
            for (let c = 0; c < columns.length; c += 1) {
                const { kind, length } = columns[c];
                for (let row = 0; columns[c].pending > 0 && row < length; row += 1) {
                    if (kind[row] > SETTLED) extend(this.seeds, s, c, row);
                }
            }
        }
    }

    public setValue(sheet: Sheet, row: number, c: number, value: Literal): void {
        this.touch(sheet, row, c);
        this.workbook.setValue(sheet, row, c, value);
    }

    public clear(sheet: Sheet, row: number, c: number): void {
        this.touch(sheet, row, c);
        this.workbook.clear(sheet, row, c);
    }

    // One formula in its stored text in every cell of a block. It holds no value until a pass computes it.
    public fillFormula(sheet: Sheet, top: number, left: number, bottom: number, right: number, text: string): void {
        this.stale = true;
        for (let c = left; c <= right; c += 1) this.seeds.push(sheet.place, c, top, bottom);
        this.workbook.fillFormula(sheet, top, left, bottom, right, text);
    }

    // Adds a sheet from its description. The index is brought up to date before the sheet is loaded, as that
    // forgets the shapes no cell of the workbook holds, and the cells of the new sheet are not the workbook's yet.
    public addSheet(source: SheetSource, place: number): EditResult {
        this.reach();
        return this.edit({ kind: ChangeKind.AddSheet, sheet: this.workbook.load(source), place });
    }

    // Performs a structural edit. The formulas whose value it can change are flagged with everything that reads
    // them while the index still describes the cells as they are, together with the cells written since the last
    // pass: so nothing but the flags, which move with their cells, has to find its way across the edit.
    public edit(change: Change): EditResult {
        const { workbook } = this;
        this.reach();
        const plan = planEdit(workbook, this.index.rectangles, change);
        const { seeds } = plan;
        for (let at = 0; at < seeds.length; at += 4) {
            const column = workbook.sheets[seeds[at]].columns[seeds[at + 1]];
            for (let row = seeds[at + 2]; row <= seeds[at + 3]; row += 1) column.markDirty(row);
        }
        this.index.mark(workbook, merged(this.seeds.concat(seeds)));
        this.seeds.length = 0;
        const dropped = workbook.apply(change, plan.fills);
        this.stale = true;
        return { rewrites: plan.rewrites, dropped };
    }

    // Computes the formulas that the cells written since the last pass reach, those that read cells they do not
    // name, and what an earlier pass left, in sheet, column, row order where the reads do not ask for another.
    public pass(cap: number, now = 0, seed = 0): RecalcResult {
        const { workbook } = this;
        workbook.sweep();
        this.evaluator.clock(now, seed);
        // With nothing written, what an edit or a pass that stopped left flagged is all there is to compute.
        if (this.seeds.length > 0) {
            this.reach();
            this.index.mark(workbook, merged(this.seeds));
            this.seeds.length = 0;
        }
        this.changed = [];
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
        return { loops, stopped, changed: this.changed };
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

    // The cell whose formula is running, as a reference.
    public running(): Reference {
        const at = this.current;
        return this.evaluator.here(this.sheets[at], this.rows[at], this.places[at]);
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

    // A cell is about to be written: it is a seed of the next pass or edit.
    private touch(sheet: Sheet, row: number, c: number): void {
        const column = sheet.columns[c];
        if (column !== undefined && column.shape[row] > 0) this.stale = true;
        extend(this.seeds, sheet.place, c, row);
    }

    // Makes the index describe the workbook as it is. The rebuild lists every shape a cell holds, so the others
    // are forgotten here: every edit that rewrites a formula would else leave its old shape behind for good.
    private reach(): void {
        if (!this.stale) return;
        const { index } = this;
        const { shapes } = this.workbook;
        for (let shape = 1; shape <= shapes.size; shape += 1) this.factsOf(shape);
        index.rebuild(this.workbook);
        const held = new Uint8Array(shapes.size + 1);
        for (let r = 5; r < index.rectangles.length; r += 6) held[index.rectangles[r]] = 1;
        shapes.keep(held);
        this.stale = false;
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
                if (this.workbook.put(joined, this.rows[at], REF)) {
                    extend(this.changed, this.sheets[at].place, this.places[at], this.rows[at]);
                }
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
        // A formula that runs again after a throw for depth makes its arrays again.
        this.made[at] = 0;
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
        if ((column.kind[row] & LOOP) === 0 && !kept && this.workbook.put(column, row, value)) {
            extend(this.changed, this.sheets[at].place, this.places[at], row);
        }
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
        if (facts < 0) {
            const { tree } = this.workbook.shapes.shape(shape);
            facts = tree === null ? 1 << FACT_BITS : shapeFacts(tree, this.functions);
            this.facts[shape] = facts;
        }
        return facts;
    }
}

// Adds a cell to runs of cells down a column, each a sheet, a column, a first and a last row: a cell right below
// the last run goes on with it.
function extend(runs: number[], sheet: number, c: number, row: number): void {
    const last = runs.length - 4;
    if (last >= 0 && runs[last] === sheet && runs[last + 1] === c && runs[last + 3] === row - 1) runs[last + 3] = row;
    else runs.push(sheet, c, row, row);
}

// A cell written twice is one seed: the spans in sheet, column and row order, those that meet as one.
function merged(seeds: readonly number[]): number[] {
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
    return spans;
}
