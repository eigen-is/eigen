// What a cell of one sheet holds beyond the value the formula engine keeps for it: the runs of a rich text, a link,
// and the mark of a text typed with a leading quote. Few cells hold any, so they are kept by place in two parallel
// lists sorted in column order, as the engine walks its cells. The workbook holds one per sheet; its appliers read
// and write a cell's entry and shift the entries when lines are inserted or deleted or a block of cells moves. The
// text of a rich cell is also the engine's value of that cell, which the workbook keeps in step.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { CellContent, Placed, Rect, Run } from '@workspace/lib/sheets/ops';

export type Extra = Readonly<Pick<CellContent, 's' | 'link' | 'qp'>>;

// The text a rich cell shows, which is the value the engine holds for it.
export function textOf(runs: readonly Run[]): string {
    return runs.map((run) => run.v).join('');
}

export class Extras {
    // A place is its column times the grid's rows plus its row, so the places ascend in column order.
    private places: number[] = [];
    private held: Extra[] = [];

    public at(row: number, column: number): Extra | undefined {
        const place = column * GRID_ROWS + row;
        const at = this.search(place);
        return this.places[at] === place ? this.held[at] : undefined;
    }

    // The entries of a block in column order. It reads the lists as it goes, so nothing is written during a walk.
    public *cells(
        [top, left, bottom, right]: Rect = [0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1],
    ): Generator<Placed<Extra>> {
        let at = this.search(left * GRID_ROWS + top);
        while (at < this.places.length) {
            const row = this.places[at] % GRID_ROWS;
            const column = (this.places[at] - row) / GRID_ROWS;
            if (column > right) return;
            if (row < top) at = this.search(column * GRID_ROWS + top);
            else if (row > bottom) at = this.search((column + 1) * GRID_ROWS + top);
            else {
                yield [row, column, this.held[at]];
                at += 1;
            }
        }
    }

    // Puts what a cell holds in place of what it held, which is returned. A cell that holds none of the three has no
    // entry, so writing none deletes.
    public put(row: number, column: number, { s, link, qp }: Extra): Extra | undefined {
        const place = column * GRID_ROWS + row;
        const at = this.search(place);
        const old = this.places[at] === place ? this.held[at] : undefined;
        const replaced = old ? 1 : 0;
        if (s || link || qp) {
            this.places.splice(at, replaced, place);
            this.held.splice(
                at,
                replaced,
                Object.freeze({ ...(s && { s }), ...(link && { link }), ...(qp && { qp }) }),
            );
        } else {
            this.places.splice(at, replaced);
            this.held.splice(at, replaced);
        }
        return old;
    }

    // The new lines hold nothing. The caller refused an insert that pushes an entry off the grid's end.
    public insert(rows: boolean, index: number, count: number): void {
        const { places } = this;
        for (let at = 0; at < places.length; at += 1) {
            const row = places[at] % GRID_ROWS;
            if (rows ? row >= index : (places[at] - row) / GRID_ROWS >= index) {
                places[at] += rows ? count : count * GRID_ROWS;
            }
        }
    }

    // Returns the entries of the deleted lines, where they were.
    public remove(rows: boolean, index: number, count: number): Placed<Extra>[] {
        const last = index + count - 1;
        const removed = this.take(rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last]);
        // The lines after the deleted ones move up, which is an insert of that many lines fewer.
        this.insert(rows, index, -count);
        return removed;
    }

    // Moves the entries of a block to another place, on this sheet or on the sheet of `to`, over whatever the block
    // lands on. Returns the entries it landed on that were not its own, where they were.
    public move(from: Rect, to: Extras, toRow: number, toColumn: number): Placed<Extra>[] {
        const [top, left, bottom, right] = from;
        const block = this.take(from);
        const covered = to.take([toRow, toColumn, toRow + bottom - top, toColumn + right - left]);
        const shift = (toColumn - left) * GRID_ROWS + toRow - top;
        const places: number[] = [];
        const held: Extra[] = [];
        let at = 0;
        // Both lists ascend, and a block shifted whole still does, so one pass merges them.
        for (const [row, column, extra] of block) {
            const place = column * GRID_ROWS + row + shift;
            for (; at < to.places.length && to.places[at] < place; at += 1) {
                places.push(to.places[at]);
                held.push(to.held[at]);
            }
            places.push(place);
            held.push(extra);
        }
        for (; at < to.places.length; at += 1) {
            places.push(to.places[at]);
            held.push(to.held[at]);
        }
        to.places = places;
        to.held = held;
        return covered;
    }

    // Takes the entries of a block out and returns them, in column order.
    private take([top, left, bottom, right]: Rect): Placed<Extra>[] {
        const { places, held } = this;
        const taken: Placed<Extra>[] = [];
        let kept = 0;
        for (let at = 0; at < places.length; at += 1) {
            const row = places[at] % GRID_ROWS;
            const column = (places[at] - row) / GRID_ROWS;
            if (row >= top && row <= bottom && column >= left && column <= right) {
                taken.push([row, column, held[at]]);
                continue;
            }
            places[kept] = places[at];
            held[kept] = held[at];
            kept += 1;
        }
        places.length = kept;
        held.length = kept;
        return taken;
    }

    // The first entry at or after a place; the entry count when none is.
    private search(place: number): number {
        let low = 0;
        let high = this.places.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (this.places[middle] < place) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
