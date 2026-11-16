// What the formulas that work a reference out as they run last resolved, a record per cell. `Recalc` tells it
// each area a running formula resolves, and has the index list the records so a marking follows them as it follows
// the references a formula names. The invariant: at all times such a formula is flagged, or its record is what it
// last resolved. A formula that runs keeps it by recording; a computed load ran none and an edit drops every
// record, so the marking after either flags them all. Nothing here is stored.

import { Fact } from '../eval/facts';
import type { Column } from '../store/column';
import type { Reference } from '../values/value';

export class Records {
    // Per cell by its column and row, the areas in the order its formula met them, five numbers each: sheet, top,
    // left, bottom, right.
    public readonly held = new Map<Column, Map<number, number[]>>();
    // Whether a record changed since the index listed them.
    public changed = false;
    // Whether formulas that resolve a reference may be neither flagged nor recorded.
    private unrecorded: boolean;
    // How much of its record each cell in progress has gone through since its formula last started.
    private readonly found: number[] = [];

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
        this.found[at] = 0;
    }

    // The formula of a cell in progress worked a reference out. Its areas go into the record of the cell where the
    // formula has come to, and an area the record holds there already changes nothing.
    public add(at: number, column: Column, row: number, reference: Reference): void {
        let rows = this.held.get(column);
        if (rows === undefined) this.held.set(column, (rows = new Map()));
        let record = rows.get(row);
        if (record === undefined) rows.set(row, (record = []));
        let from = this.found[at];
        for (let area: Reference | null = reference; area !== null; area = area.next) {
            const { sheet, top, left, bottom, right } = area;
            const same =
                record[from] === sheet &&
                record[from + 1] === top &&
                record[from + 2] === left &&
                record[from + 3] === bottom &&
                record[from + 4] === right;
            if (!same) {
                record[from] = sheet;
                record[from + 1] = top;
                record[from + 2] = left;
                record[from + 3] = bottom;
                record[from + 4] = right;
                this.changed = true;
            }
            from += 5;
        }
        this.found[at] = from;
    }

    // The formula of a cell in progress ended: what its record holds past the areas it resolved this time, it
    // resolves no more.
    public end(at: number, column: Column, row: number): void {
        const record = this.held.get(column)?.get(row);
        if (record === undefined || record.length <= this.found[at]) return;
        record.length = this.found[at];
        this.changed = true;
    }
}
