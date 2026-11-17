// Recalc on demand. Every write and structural edit goes through here, as one body that first notes or flags what
// is to be computed and then changes the store. A pass flags the formulas the written cells reach, and those that a
// new clock, a structural edit or other rows left out can change, with the readers of each, and computes them:
// reading a cell still to be computed computes it first, so no order is worked out ahead, and a cell met while it is
// computed is on a loop. The areas a formula works out as it runs are told to the `Records`, which a marking follows.

import { Evaluator } from '../eval/evaluator';
import { FACT_BITS, Fact, shapeFacts } from '../eval/facts';
import type { Registry } from '../functions/registry';
import type { Column } from '../store/column';
import { CellKind, DIRTY, KIND_MASK, LOOP, RUNNING, SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Change, Draft, Literal, Workbook } from '../store/workbook';
import { ChangeKind } from '../store/workbook';
import { ERROR, REF } from '../values/errors';
import type { Reference, Scalar } from '../values/value';
import type { Rewrite } from './edit-plan';
import { planEdit } from './edit-plan';
import { Records } from './records';
import { ReverseIndex, TABS } from './reverse-index';

type CellAddress = { readonly sheet: string; readonly row: number; readonly column: number };

export type RecalcResult = {
    // Every cell of the workbook that is on a circular reference, in sheet, column, row order. Final only when
    // `stopped` is false. Only computing finds a loop, so one loaded with other values than #REF! shows once computed.
    readonly loops: readonly CellAddress[];
    // True when the pass met its cap with formulas still to compute. What it computed stays, and the next goes on.
    readonly stopped: boolean;
    // The cells whose value the pass changed, as runs down a column: the place of the sheet, the column, the
    // first and the last row. They are true until the next edit or pass.
    readonly changed: readonly number[];
};

export type EditResult = { readonly rewrites: readonly Rewrite[] };

// How much of the stack the cells in progress may take together before their calls are dropped, in the units of a
// shape's depth: half of the smallest stack the engine runs on. Reading a cell takes CELL on top of its shape.
const BUDGET = 640;
const CELL = 6;

// The most elements one array stores, which bounds memory, and the most work one formula does, which bounds time:
// array elements, characters of texts made for them and numbers added one by one. Past either it is #CALC!, alone.
const MOST_STORED = 2 ** 24;
const MOST_WORK = 2 ** 27;

const UNWIND = Object.freeze({ reason: 'the evaluation nests too deep' });
const STOP = Object.freeze({ reason: 'the recalc computed as many formulas as its cap' });

export class Recalc {
    private readonly workbook: Workbook;
    private readonly functions: Registry;
    private readonly evaluator: Evaluator;
    private readonly index = new ReverseIndex();
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
    // How many numbers each cell in progress has drawn since its formula last started.
    private readonly drew: number[] = [];
    // The area each cell in progress is having computed, which a throw for depth leaves for the pass, or null.
    private readonly areas: (Reference | null)[] = [];
    // Moves with every pass and every loop that closes: what a pass carried from one formula to the next holds
    // only within one era.
    public era = 0;
    // The clock of the last batch of edits: its author's date and time as a serial, and what its draws are made
    // of beside the cell that draws.
    public now: number;
    private seed: number;
    // Whether the clock formulas were flagged since the clock was last set or a structural edit moved cells.
    private stamped = true;
    // The sheets whose hidden or filtered rows changed, or whose cells an edit moved across them, since a pass
    // flagged the formulas that leave rows out.
    private readonly rowed = new Set<Sheet>();
    private readonly records: Records;

    // `computed` says whether the values of the workbook are those a full pass computed, as its load was told.
    public constructor(workbook: Workbook, functions: Registry, now: number, seed: number, computed: boolean) {
        this.records = new Records(computed);
        this.workbook = workbook;
        this.functions = functions;
        this.facts = workbook.shapes.facts;
        this.evaluator = new Evaluator(workbook, functions, this);
        this.now = now;
        this.seed = seed;
        for (const sheet of workbook.sheets) {
            this.index.forget(sheet);
            this.hold(sheet, computed);
        }
    }

    // No seed waits, the clock is stamped, no sheet's rows changed, and no formula is flagged.
    public settled(): boolean {
        if (this.seeds.length > 0 || !this.stamped || this.rowed.size > 0) return false;
        return this.workbook.sheets.every((sheet) => sheet.pending === 0);
    }

    // The clock of a batch of edits, before or after its writes: the next pass computes every clock formula again.
    public setClock(now: number, seed: number): void {
        this.now = now;
        this.seed = seed;
        this.stamped = false;
    }

    // The rows a sheet hides and filters, whole. Other rows than it held are a change the next pass follows: it
    // computes again every formula that leaves rows out and can read the sheet.
    public setRowsOut(sheet: Sheet, hidden: readonly number[], filtered: readonly number[]): void {
        if (sheet.leaveOut(hidden, filtered)) this.rowed.add(sheet);
    }

    public setValue(sheet: Sheet, row: number, c: number, value: Literal): void {
        this.touch(sheet, row, c);
        this.workbook.setValue(sheet, row, c, value);
    }

    public clear(sheet: Sheet, row: number, c: number): void {
        this.touch(sheet, row, c);
        this.workbook.clear(sheet, row, c);
    }

    // One formula in its stored text in every cell of a block. It holds no value until a pass computes it, unless
    // this build cannot evaluate it: then every cell holds the value it was given and waits for no pass.
    public fillFormula(
        sheet: Sheet,
        top: number,
        left: number,
        bottom: number,
        right: number,
        text: string,
        given: Literal | null,
    ): void {
        this.index.forget(sheet);
        for (let c = left; c <= right; c += 1) this.seeds.push(sheet.place, c, top, bottom);
        this.workbook.fillFormula(sheet, top, left, bottom, right, text);
        if ((this.factsOf(sheet.columns[left].shape[top]) & Fact.Kept) === 0) return;
        for (let c = left; c <= right; c += 1) {
            for (let row = top; row <= bottom; row += 1) this.keep(sheet.columns[c], row, given);
        }
    }

    // Adds a sheet that was read from its description. The index is brought up to date before the tables take the
    // sheet's texts and shapes, as that forgets the shapes no cell of the workbook holds, and these are not yet.
    public addSheet(draft: Draft, place: number): EditResult {
        this.reach();
        const sheet = this.workbook.adopt(draft);
        const result = this.edit({ kind: ChangeKind.AddSheet, sheet, place });
        this.hold(sheet, false);
        return result;
    }

    // Performs a structural edit. What it can change is flagged, with the cells written since the last pass, while
    // the index still describes the cells as they are: so only the flags, which move with their cells, cross the edit.
    public edit(change: Change): EditResult {
        const { workbook } = this;
        // The marking below flags every formula that resolves a reference. An edit that is refused leaves that to
        // the next marking.
        this.records.drop();
        this.reach();
        // A draw it moves is drawn again by its new place.
        this.stamped = false;
        // The sheets whose cells come, go or move: one that moves among the tabs or gets another name keeps its own.
        const named =
            change.kind === ChangeKind.Move
                ? [workbook.known(change.move.fromSheet), workbook.known(change.move.toSheet)]
                : change.kind === ChangeKind.Lines
                  ? [workbook.known(change.edit.sheet)]
                  : change.kind === ChangeKind.AddSheet
                    ? [change.sheet]
                    : change.kind === ChangeKind.RemoveSheet
                      ? [workbook.known(change.sheet)]
                      : [];
        // And a cell it moves to another row is left out or not by that row: the rows a sheet leaves out are not
        // moved with its cells, so they count as changed on every sheet the cells left or came to.
        const moves = change.kind === ChangeKind.Move || (change.kind === ChangeKind.Lines && change.edit.rows);
        if (moves && named.some((sheet) => sheet.out.length > 0)) for (const sheet of named) this.rowed.add(sheet);
        for (const sheet of named) this.index.forget(sheet);
        // Only a block on those sheets or one that names them can change, and with the tabs one that reads them.
        const ids = named.map((sheet) => sheet.id);
        const cells = change.kind === ChangeKind.Move || change.kind === ChangeKind.Lines;
        const plan = planEdit(workbook, this.index.reading(named, cells ? ids : [...ids, TABS]), change);
        const { seeds, fills } = plan;
        for (let f = 0; f < fills.length; f += 6) this.index.reshape(workbook.sheets[fills[f]]);
        for (let at = 0; at < seeds.length; at += 4) {
            const column = workbook.sheets[seeds[at]].columns[seeds[at + 1]];
            for (let row = seeds[at + 2]; row <= seeds[at + 3]; row += 1) column.markDirty(row);
        }
        this.index.mark(workbook, merged(this.seeds.concat(seeds)), this.records.takeUnrecorded());
        this.seeds.length = 0;
        workbook.apply(change, fills);
        return { rewrites: plan.rewrites };
    }

    // Computes the formulas that the cells written since the last pass reach, those that ask the workbook itself or
    // read a clock that was set, and what an earlier pass left, in sheet, column, row order where no read asks another.
    public pass(cap: number): RecalcResult {
        const { workbook } = this;
        workbook.sweep();
        this.era += 1;
        if (!this.stamped) {
            // A clock formula is flagged here and is a seed, as a marking flags only what reads one.
            this.reach();
            const clocks = this.index.reading([], [Fact.Clock]);
            for (let i = 0; i < clocks.length; i += 6) this.flagBlock(clocks, i);
            this.stamped = true;
        }
        if (this.rowed.size > 0) {
            // So is a formula that leaves rows out, when it names a sheet whose rows changed or may read any.
            this.reach();
            const ids = Array.from(this.rowed, (sheet) => sheet.id);
            const choosers = this.index.reading([], [Fact.Resolves, ...ids]);
            for (let i = 0; i < choosers.length; i += 6) {
                if ((this.facts[choosers[i + 5]] & (Fact.Chosen | Fact.Kept)) === Fact.Chosen)
                    this.flagBlock(choosers, i);
            }
            this.rowed.clear();
        }
        // With nothing written, what an edit or a pass that stopped left flagged is all there is to compute.
        if (this.seeds.length > 0) {
            this.reach();
            this.index.mark(workbook, merged(this.seeds), this.records.takeUnrecorded());
            this.seeds.length = 0;
        }
        this.changed = [];
        this.cost = 0;
        this.stored = false;
        this.cap = cap;
        let stopped = false;
        try {
            for (const sheet of workbook.sheets) {
                const { columns } = sheet;
                for (let c = 0; sheet.pending > 0 && c < columns.length; c += 1) {
                    const column = columns[c];
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
            const { columns } = sheet;
            const listed = loops.length + sheet.loops;
            for (let c = 0; loops.length < listed && c < columns.length; c += 1) {
                const { kind, length } = columns[c];
                for (let row = 0; columns[c].loops > 0 && row < length; row += 1) {
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

    // The next number in [0, 1) the running formula draws. Its n-th draw is made of the seed, its sheet, its row, its
    // column and n alone: so it is the same in whatever order cells compute and however often the formula starts again.
    public draw(): number {
        const at = this.current;
        const count = this.drew[at] + 1;
        this.drew[at] = count;
        let mixed = Math.imul(this.seed ^ this.sheets[at].salt, 0x9e3779b1);
        mixed = Math.imul(mixed ^ (mixed >>> 15) ^ this.rows[at], 0x85ebca6b);
        mixed = Math.imul(mixed ^ (mixed >>> 13) ^ this.places[at], 0xc2b2ae35);
        mixed = ((mixed ^ (mixed >>> 16)) + Math.imul(count, 0x6d2b79f5)) | 0;
        mixed = Math.imul(mixed ^ (mixed >>> 15), 1 | mixed);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    }

    // The running formula worked a reference out.
    public record(reference: Reference): void {
        this.records.add(this.current, reference);
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

    // Holds the formulas of a loaded or added sheet this build cannot evaluate, a seed where that changed a computed
    // load. A load carries no loops, so any other formula that came with #REF! is a seed, to be computed again.
    private hold(sheet: Sheet, computed: boolean): void {
        for (let c = 0; c < sheet.columns.length; c += 1) {
            const column = sheet.columns[c];
            const { kind, ref, shape, length } = column;
            // Whether the shape of the row before is one this build cannot evaluate: most rows share it.
            let last = 0;
            let kept = false;
            for (let row = 0; row < length; row += 1) {
                const id = shape[row];
                if (id === 0) continue;
                if (id !== last) {
                    last = id;
                    kept = (this.factsOf(id) & Fact.Kept) !== 0;
                }
                if (kept) {
                    const changed = this.keep(column, row, this.workbook.value(column, row));
                    if (changed && computed) extend(this.seeds, sheet.place, c, row);
                } else if (kind[row] === CellKind.Error && ref[row] === REF.code) {
                    column.markDirty(row);
                    extend(this.seeds, sheet.place, c, row);
                }
            }
        }
    }

    // Flags the formulas of a block the index gave, from `at` in a list: sheet, first and last column, first and
    // last row. Each of its columns is a seed.
    private flagBlock(rectangles: readonly number[], at: number): void {
        const { columns } = this.workbook.sheets[rectangles[at]];
        for (let c = rectangles[at + 1]; c <= rectangles[at + 2]; c += 1) {
            for (let row = rectangles[at + 3]; row <= rectangles[at + 4]; row += 1) columns[c].markDirty(row);
            this.seeds.push(rectangles[at], c, rectangles[at + 3], rectangles[at + 4]);
        }
    }

    // A formula this build cannot evaluate holds the value it enters with, and #REF! with none, from that moment on:
    // no pass computes it. True when that changed the cell.
    private keep(column: Column, row: number, value: Scalar): boolean {
        column.settle(row);
        return this.workbook.put(column, row, value ?? REF);
    }

    // A cell is about to be written: it is a seed of the next pass or edit.
    private touch(sheet: Sheet, row: number, c: number): void {
        const column = sheet.columns[c];
        if (column !== undefined && column.shape[row] > 0) this.index.forget(sheet);
        extend(this.seeds, sheet.place, c, row);
    }

    // Makes the index describe the workbook and the records as they are. The record of a cell that holds no
    // formula that resolves a reference any more is forgotten.
    private reach(): void {
        const { index, records, facts } = this;
        if (index.stale) {
            index.rebuild(this.workbook, (shape) => this.factsOf(shape));
            records.prune(this.workbook.sheets, facts);
        }
        if (records.changed) {
            index.listRecords(this.workbook.sheets, records.held);
            records.changed = false;
        }
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
        this.era += 1;
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
        const facts = this.factsOf(shape);
        const kept = (facts & Fact.Kept) !== 0;
        // The cap is met before a formula runs, so a pass that stops throws no finished formula away, and never
        // before the first store of the pass: a formula that costs more than the cap alone would hold every pass up.
        if (this.cost >= this.cap && this.stored) throw STOP;
        // A formula that runs again after a throw for depth makes its arrays again, and its draws.
        this.made[at] = 0;
        this.drew[at] = 0;
        const resolves = (facts & Fact.Resolves) !== 0;
        if (resolves) this.records.start(at);
        const { tree } = this.workbook.shapes.shape(shape);
        const value = kept
            ? this.workbook.value(column, row)
            : tree === null
              ? ERROR
              : this.evaluator.result(tree, this.sheets[at], row, this.places[at], (facts & Fact.Anchored) !== 0);
        if (resolves) this.records.end(at, this.sheets[at].place, this.places[at], row);
        this.current = this.parents[at];
        // On a loop that an earlier cell has still to close: it stays in the list for whoever reads it.
        if (this.lows[at] < at) return;
        this.stored = true;
        if ((column.kind[row] & LOOP) === 0 && this.workbook.put(column, row, value)) {
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
