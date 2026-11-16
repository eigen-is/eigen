import type { Literal, SheetSource } from '../../index';
import { Engine } from '../../index';
import { sheetFinder, storedText } from '../../text';
import { random } from '../store/support';

// The law of the clock: whoever reads one log of batches ends with the same values, whenever its passes ran and
// wherever they stopped. A log is random batches over two sheets, each with a clock of its own: values, formulas
// that draw, read the clock, read each other and the other sheet, row inserts and deletes, and the second sheet
// removed, put back and moved. `runClockLaw` has seven readers read each log and names those that differ from
// the one that ran a whole pass after every batch.

const NO_CAP = Number.POSITIVE_INFINITY;
const ROWS = 6;
const COLUMNS = 3;
const NAMES: Readonly<Record<string, string>> = { s1: 'S', s2: 'T' };
const find = sheetFinder(Object.entries(NAMES).map(([id, name]) => ({ id, name })));

const FORMS = [
    '=RAND()',
    '=A1+A2+TODAY()',
    '=RAND()+B1+RAND()',
    '=IF(A1>50,RANDBETWEEN(1,6),"")',
    '=B2*2',
    '=SUM(A1:C6)',
    '=NOW()-A3',
    '=C1+RAND()',
    '=IF(RAND()<0.5,"",1)',
    '=SUM(RANDBETWEEN(A1:A3,100))',
    '=T!A1+RAND()',
    '=S!B2+1',
    '=SUM(T!A1:C6)',
    '=A1',
    '=ROW()+RAND()',
    '=DATEVALUE("1/2")+A1',
];
// The mix for logs that mostly remove the second sheet and put it back.
const ACROSS = [
    '=S!B2+1',
    '=SUM(S!A1:B3)',
    '=A1',
    '=B2*2',
    '=SUM(A1:B3)',
    '=T!A1+1',
    '=A1+NOW()',
    '=INDIRECT("S!A1")',
    '=INDIRECT("S!A1")+RAND()',
    '=S!A1+B1',
    '=T!B2',
    '=S!A3',
];

type Op =
    | {
          readonly kind: 'value';
          readonly sheet: string;
          readonly row: number;
          readonly column: number;
          readonly value: number;
      }
    | {
          readonly kind: 'formula';
          readonly sheet: string;
          readonly row: number;
          readonly column: number;
          readonly text: string;
      }
    | { readonly kind: 'lines'; readonly sheet: string; readonly row: number; readonly insert: boolean }
    | { readonly kind: 'remove' }
    | { readonly kind: 'add'; readonly place: number }
    | { readonly kind: 'move'; readonly place: number };
type Batch = { readonly now: number; readonly seed: number; readonly ops: readonly Op[] };
type Cell = readonly [row: number, column: number, value: Literal | null, formula: string | null];

function source(id: string, cells: readonly Cell[]): SheetSource {
    return {
        id,
        name: NAMES[id],
        cells: (cell) => {
            for (const [row, column, value, formula] of cells) cell(row, column, value, formula);
        },
    };
}

// One reader of a log. A sheet it removed is held as the cells it had, as a host holds them for the undo.
class Reader {
    public engine: Engine;
    private held: Cell[] | null;

    public constructor(
        engine = new Engine([source('s1', []), source('s2', [])], 0, 0, false),
        held: Cell[] | null = null,
    ) {
        this.engine = engine;
        this.held = held;
    }

    public apply(batch: Batch): void {
        const { engine } = this;
        for (const op of batch.ops) {
            if (op.kind === 'remove') {
                if (this.held !== null) continue;
                this.held = this.cells('s2');
                engine.removeSheet('s2');
            } else if (op.kind === 'add') {
                if (this.held === null) continue;
                engine.addSheet(source('s2', this.held), op.place);
                this.held = null;
            } else if (op.kind === 'move') {
                if (this.held === null) engine.moveSheet('s2', op.place);
            } else if (op.sheet === 's2' && this.held !== null) {
            } else if (op.kind === 'formula') {
                engine.setFormula(op.sheet, op.row, op.column, storedText(op.text, op.row, op.column, find));
            } else if (op.kind === 'value') {
                engine.setValue(op.sheet, op.row, op.column, op.value);
            } else {
                engine.editLines({ sheet: op.sheet, rows: true, index: op.row, count: 1, insert: op.insert });
            }
        }
    }

    // Applies a batch with its clock, and has a pass compute at most `cap` formulas. True when the pass stopped.
    public take(batch: Batch, cap: number): boolean {
        this.apply(batch);
        this.engine.setClock(batch.now, batch.seed);
        return this.engine.recalc(cap).stopped;
    }

    // The sheets in tab order, each cell with whether it waits to be computed.
    public dump(): string {
        const sheets = this.sheets().map((id) => [
            id,
            this.cells(id).map((cell) => [...cell, this.engine.isPending(id, cell[0], cell[1])]),
        ]);
        return JSON.stringify(sheets);
    }

    // A new reader loaded from a walk of this one, with the clock the walk was computed with, as computed when this
    // one is settled. With `bare`, no formula brings its value.
    public loaded(now: number, seed: number, bare = false): Reader {
        const sheets = this.sheets().map((id) =>
            source(
                id,
                this.cells(id).map(([row, column, value, formula]) => [
                    row,
                    column,
                    bare && formula !== null ? null : value,
                    formula,
                ]),
            ),
        );
        return new Reader(new Engine(sheets, now, seed, !bare && this.engine.settled()), this.held);
    }

    public formulas(): number {
        let count = 0;
        for (const id of this.sheets()) for (const cell of this.cells(id)) if (cell[3] !== null) count += 1;
        return count;
    }

    private sheets(): string[] {
        return this.held === null ? [this.engine.sheetAt(0), this.engine.sheetAt(1)] : ['s1'];
    }

    private cells(sheet: string): Cell[] {
        const cells: Cell[] = [];
        this.engine.cells(sheet, (row, column, value, formula) => cells.push([row, column, value, formula]));
        return cells;
    }
}

export type ClockLawCounts = {
    logs: number;
    batches: number;
    // Passes that stopped with the next batch arriving on top.
    stopped: number;
    sheetOps: number;
    // Each log with a reader that differs, as its number and the reader's name, or what else went wrong with it.
    differing: string[];
};

// Reads `count` random logs. With `across`, most ops remove the second sheet, put it back or read across sheets.
export function runClockLaw(seed: number, count: number, across: boolean): ClockLawCounts {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const counts: ClockLawCounts = { logs: count, batches: 0, stopped: 0, sheetOps: 0, differing: [] };
    // Out of twenty, where formulas, values, inserts, deletes and removes end: then nine adds in ten, and a move.
    const [formulas, written, inserted, deleted, removed] = across ? [6, 11, 12, 13, 16] : [9, 15, 16, 17, 18];
    for (let trial = 0; trial < count; trial += 1) {
        const log: Batch[] = [];
        const length = 2 + pick(14);
        for (let i = 0; i < length; i += 1) {
            const ops: Op[] = [];
            for (let more = pick(3); more >= 0; more -= 1) {
                const sheet = pick(across ? 2 : 3) > 0 ? 's1' : 's2';
                const row = pick(across ? 3 : ROWS);
                const column = pick(across ? 2 : COLUMNS);
                const kind = pick(20);
                const forms = across ? ACROSS : FORMS;
                if (kind < formulas) ops.push({ kind: 'formula', sheet, row, column, text: forms[pick(forms.length)] });
                else if (kind < written) ops.push({ kind: 'value', sheet, row, column, value: pick(100) });
                else if (kind < deleted) ops.push({ kind: 'lines', sheet, row, insert: kind < inserted });
                else if (kind < removed) ops.push({ kind: 'remove' });
                else if (kind < 19) ops.push({ kind: 'add', place: pick(2) });
                else ops.push({ kind: 'move', place: pick(2) });
                if (kind >= deleted) counts.sheetOps += 1;
            }
            log.push({ now: 46000 + i + pick(10) / 10, seed: pick(2 ** 30), ops });
        }
        counts.batches += length;
        const last = log[length - 1];

        const live = new Reader();
        for (const batch of log) live.take(batch, NO_CAP);

        const replay = new Reader();
        for (const batch of log) replay.apply(batch);
        replay.engine.setClock(last.now, last.seed);
        replay.engine.recalc(NO_CAP);

        const capped = new Reader();
        for (const batch of log) if (capped.take(batch, 1 + pick(3))) counts.stopped += 1;
        // A pass that stops has stored a formula, so one pass per formula and one more end it.
        let unsettled = true;
        for (let left = capped.formulas(); unsettled && left >= 0; left -= 1) {
            unsettled = capped.engine.recalc(2).stopped;
        }
        if (unsettled) counts.differing.push(`${trial} capped never settles`);

        // Passes in between that ran with a clock no batch has.
        const wrong = new Reader();
        for (const batch of log) {
            wrong.apply(batch);
            if (pick(2) === 0) continue;
            wrong.engine.setClock(1, 1);
            wrong.engine.recalc(pick(2) === 0 ? NO_CAP : 2);
        }
        wrong.engine.setClock(last.now, last.seed);
        wrong.engine.recalc(NO_CAP);

        // A fold after one batch: a pass to the end, a walk and a load with that batch's clock, then the rest.
        let fold = new Reader();
        const foldAt = pick(length);
        for (let i = 0; i < length; i += 1) {
            if (i === foldAt) {
                fold.take(log[i], NO_CAP);
                fold = fold.loaded(log[i].now, log[i].seed);
            } else if (pick(2) === 0) fold.take(log[i], 3);
            else {
                fold.apply(log[i]);
                fold.engine.setClock(log[i].now, log[i].seed);
            }
        }
        fold.engine.recalc(NO_CAP);

        // A pass over a load of the end state changes nothing: it computes only what holds #REF!.
        const load = live.loaded(last.now, last.seed);
        const changedAtLoad = load.engine.recalc(NO_CAP).changed.length;

        const bare = live.loaded(last.now, last.seed, true);
        bare.engine.recalc(NO_CAP);

        const expected = live.dump();
        const readers = { replay, capped, wrong, fold, load, bare };
        for (const [name, reader] of Object.entries(readers)) {
            if (reader.dump() !== expected) counts.differing.push(`${trial} ${name}`);
        }
        if (changedAtLoad > 0) counts.differing.push(`${trial} load changed`);
    }
    return counts;
}
