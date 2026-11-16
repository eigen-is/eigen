// What the formulas that work a reference out as they run last resolved: per cell, one box for each sheet it
// resolved into, around every area of that sheet. The index lists the records, so a marking follows them as it
// follows the references a formula names. The invariant: at all times such a formula is flagged, or its record
// covers everything it last resolved. A formula that runs records; a computed load ran none and an edit drops
// every record, so the marking after either flags them all. Nothing here is stored.

import { Fact } from '../eval/facts';
import type { Column } from '../store/column';
import type { Reference } from '../values/value';

export class Records {
    // Per cell by its column and row, a box for each sheet its formula resolved into, five numbers each: sheet,
    // top, left, bottom, right.
    public readonly held = new Map<Column, Map<number, number[]>>();
    // Whether a record changed since the index listed them.
    public changed = false;
    // Whether formulas that resolve a reference may be neither flagged nor recorded.
    private unrecorded: boolean;
    // Per cell in progress, the boxes its formula has resolved since it last started, in the same five numbers.
    private readonly runs: number[][] = [];

    // `computed` says whether the workbook came with the values of a full pass, which ran no formula here.
    public constructor(computed: boolean) {
        this.unrecorded = computed;
    }

    // An edit moves cells and areas, so no record holds.
    public drop(): void {
        if (this.held.size > 0) this.changed = true;
        this.held.clear();
        this.unrecorded = true;
    }

    // Whether the marking that asks is to flag every formula that resolves a reference: once, as it then does.
    public takeUnrecorded(): boolean {
        const unrecorded = this.unrecorded;
        this.unrecorded = false;
        return unrecorded;
    }

    // Forgets the record of every cell that holds no formula that resolves a reference any more, by the facts of
    // each shape, or one this build cannot evaluate.
    public prune(facts: readonly number[]): void {
        for (const [column, rows] of this.held) {
            for (const row of rows.keys()) {
                const shape = row < column.length ? column.shape[row] : 0;
                if ((facts[shape] & (Fact.Resolves | Fact.Kept)) === Fact.Resolves) continue;
                rows.delete(row);
                this.changed = true;
            }
        }
    }

    // The formula of a cell in progress starts, at `at` in the list of them.
    public start(at: number): void {
        const run = this.runs[at];
        if (run === undefined) this.runs[at] = [];
        else run.length = 0;
    }

    // The formula of a cell in progress worked a reference out: the box of each area's sheet widens to hold it.
    public add(at: number, reference: Reference): void {
        const run = this.runs[at];
        for (let area: Reference | null = reference; area !== null; area = area.next) {
            let box = 0;
            while (box < run.length && run[box] !== area.sheet) box += 5;
            if (box === run.length) run.push(area.sheet, area.top, area.left, area.bottom, area.right);
            else {
                if (area.top < run[box + 1]) run[box + 1] = area.top;
                if (area.left < run[box + 2]) run[box + 2] = area.left;
                if (area.bottom > run[box + 3]) run[box + 3] = area.bottom;
                if (area.right > run[box + 4]) run[box + 4] = area.right;
            }
        }
    }

    // The formula of a cell in progress ended: its boxes are the record of the cell, unless they are already.
    public end(at: number, column: Column, row: number): void {
        const run = this.runs[at];
        let rows = this.held.get(column);
        const record = rows?.get(row);
        let same = (record?.length ?? 0) === run.length;
        for (let i = 0; same && record !== undefined && i < run.length; i += 1) same = record[i] === run[i];
        if (same) return;
        this.changed = true;
        if (rows === undefined) this.held.set(column, (rows = new Map()));
        if (run.length === 0) rows.delete(row);
        else rows.set(row, run.slice());
    }
}
