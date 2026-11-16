// Where the looks of one sheet live. No cell stores a look: the sheet's columns are cut into bands, neighbouring
// columns that share one run list, which says the look each row wears, so a formatted column is one band with one
// run and a formatted row one write to each band. Bands cover every column and a list every row: there is no second
// layer of row or column defaults. The workbook holds one per sheet and its appliers read, format and shift it;
// neighbouring bands never hold equal lists, so equal sheets are equal arrays.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { LinesOp, MoveOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { RunList } from './run-list';

// The columns from `first` up to the next band's first, or to the grid's last column.
type Band = { first: number; list: RunList };

// A rectangle of cells that wear one look id, every bound inclusive.
export type LookSpan = {
    readonly c0: number;
    readonly c1: number;
    readonly r0: number;
    readonly r1: number;
    readonly look: number;
};

export class Bands {
    private readonly bands: Band[] = [{ first: 0, list: new RunList() }];

    // A sheet from a snapshot's flat form: per band its first column, n, then n pairs of start row and look index,
    // where index i names `looks[i - 1]` and 0 is plain. Equal neighbours join; columns before the first are plain.
    public constructor(flat: readonly number[], looks: readonly number[]) {
        const ids = [0, ...looks];
        for (let at = 0; at < flat.length; at += 2 + 2 * flat[at + 1]) {
            const runs: number[] = [];
            for (let i = at + 2; i < at + 2 + 2 * flat[at + 1]; i += 2) runs.push(flat[i], ids[flat[i + 1]]);
            const list = RunList.of(runs);
            const last = this.bands[this.bands.length - 1];
            if (flat[at] === 0) last.list = list;
            else if (!last.list.equals(list)) this.bands.push({ first: flat[at], list });
        }
    }

    public look(row: number, column: number): number {
        return this.bands[this.bandAt(column)].list.lookAt(row);
    }

    // The spans that tile a rectangle, plain ones included, in column order then row order.
    public *spans([top, left, bottom, right]: Rect): Generator<LookSpan> {
        const { bands } = this;
        for (let b = this.bandAt(left); b < bands.length && bands[b].first <= right; b += 1) {
            const { first, list } = bands[b];
            const c0 = Math.max(left, first);
            const c1 = Math.min(right, (b + 1 < bands.length ? bands[b + 1].first : GRID_COLUMNS) - 1);
            if (list.count === 0) yield { c0, c1, r0: top, r1: bottom, look: 0 };
            for (let i = list.runAt(top); i < list.count && list.startOf(i) <= bottom; i += 1) {
                const end = i + 1 < list.count ? list.startOf(i + 1) : GRID_ROWS;
                yield {
                    c0,
                    c1,
                    r0: Math.max(top, list.startOf(i)),
                    r1: Math.min(bottom, end - 1),
                    look: list.lookOf(i),
                };
            }
        }
    }

    // The styled part of the used range. A run or band that reaches the grid's end counts only up to where it starts,
    // and a plain one not at all; -1 where nothing is styled.
    public extent(): { lastRow: number; lastColumn: number } {
        let lastRow = -1;
        for (const { list } of this.bands) {
            if (list.count === 0) continue;
            const start = list.startOf(list.count - 1);
            lastRow = Math.max(lastRow, list.lookOf(list.count - 1) === 0 ? start - 1 : start);
        }
        const last = this.bands[this.bands.length - 1];
        return { lastRow, lastColumn: last.list.count === 0 ? last.first - 1 : last.first };
    }

    // What the limit on formats counts.
    public weight(): { runs: number; bands: number } {
        let runs = 0;
        for (const { list } of this.bands) runs += list.count;
        return { runs, bands: this.bands.length };
    }

    // The most that writes over these spans of columns can add, in any order and when only some land. A write copies
    // the runs of the band it cuts at each end, then adds at most three runs to each band the cuts leave in its columns.
    public growth(writes: readonly Span[]): { runs: number; bands: number } {
        const { bands } = this;
        let runs = 0;
        const cuts = new Set<number>();
        for (const [c0, c1] of writes) {
            for (const column of [c0, c1 + 1]) {
                const band = bands[this.bandAt(column)];
                if (column >= GRID_COLUMNS || band.first === column || cuts.has(column)) continue;
                cuts.add(column);
                runs += band.list.count;
            }
        }
        const sorted = [...cuts].sort((a, b) => a - b);
        // How many cuts lie at or before a column.
        const cutsTo = (column: number) => {
            let low = 0;
            let high = sorted.length;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (sorted[middle] <= column) low = middle + 1;
                else high = middle;
            }
            return low;
        };
        for (const [c0, c1] of writes) {
            runs += 3 * (this.bandAt(c1) - this.bandAt(c0) + 1 + cutsTo(c1) - cutsTo(c0));
        }
        return { runs, bands: cuts.size };
    }

    // The flat form of the constructor, with the look ids it names in order of first use, walking bands then runs.
    public content(): { looks: number[]; bands: number[] } {
        const looks: number[] = [];
        const indexes = new Map([[0, 0]]);
        const bands: number[] = [];
        for (const { first, list } of this.bands) {
            bands.push(first, list.count);
            for (let i = 0; i < list.count; i += 1) {
                const look = list.lookOf(i);
                let index = indexes.get(look);
                if (index === undefined) {
                    index = looks.push(look);
                    indexes.set(look, index);
                }
                bands.push(list.startOf(i), index);
            }
        }
        return { looks, bands };
    }

    // Every cell of the rectangle wears `to` of the look it wore. Returns the spans it replaced.
    public write(rect: Rect, to: (look: number) => number): LookSpan[] {
        const replaced = [...this.spans(rect)];
        this.each(rect[1], rect[3], (list) => list.format(rect[0], rect[2], to));
        return replaced;
    }

    // The block leaves `source`, plain where it was, and lands here over what it returns: the spans it covered, as
    // they were before the move. Look ids are the workbook's, so a block crosses sheets as it is.
    public move({ from, toRow, toColumn }: MoveOp, source: Bands): LookSpan[] {
        const [top, left, bottom, right] = from;
        const rowShift = toRow - top;
        const columnShift = toColumn - left;
        const covered = [...this.spans([toRow, toColumn, bottom + rowShift, right + columnShift])];
        const spans = source.write(from, () => 0);
        let at = 0;
        while (at < spans.length) {
            // The spans of one band stand together: one cut of the columns writes them all.
            const { c0, c1 } = spans[at];
            let end = at;
            while (end < spans.length && spans[end].c0 === c0) end += 1;
            this.each(c0 + columnShift, c1 + columnShift, (list) => {
                for (let i = at; i < end; i += 1) {
                    list.format(spans[i].r0 + rowShift, spans[i].r1 + rowShift, () => spans[i].look);
                }
            });
            at = end;
        }
        return covered;
    }

    // Whether the insert would push off the grid's end a line that does not wear the look of the last line that
    // stays, or of plain when none stays. Such an insert has no delete that undoes it.
    public wouldPush({ rows, count }: LinesOp): boolean {
        if (rows) {
            return this.bands.some(({ list }) => list.count > 0 && list.startOf(list.count - 1) >= GRID_ROWS - count);
        }
        const last = this.bands[this.bands.length - 1];
        return last.first >= GRID_COLUMNS - count && (last.first > 0 || last.list.count > 0);
    }

    // New lines wear the look of the line `like`: the one before them, the one they push on, or plain when there is
    // none. Lines that enter at the grid's end on a delete wear the look of the last line that stays.
    public lines({ rows, insert, index, count, like = -1 }: LinesOp): LookSpan[] {
        const { bands } = this;
        const last = index + count - 1;
        if (insert) {
            if (rows) for (const { list } of bands) list.insertRows(index, count, like);
            else {
                // Beside the column `like` the new columns only widen its band.
                const from = like === index ? index + 1 : index;
                for (let i = bands.length - 1; i > 0 && bands[i].first >= from; i -= 1) bands[i].first += count;
                if (like < 0) this.each(index, last, (list) => list.format(0, GRID_ROWS - 1, () => 0));
            }
            return [];
        }
        const removed = [...this.spans(rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last])];
        if (rows) {
            for (const { list } of bands) list.deleteRows(index, count);
            this.join(1, bands.length - 1);
        } else {
            const low = this.split(index);
            const high = this.split(index + count);
            bands.splice(low, high - low);
            for (let i = low; i < bands.length; i += 1) bands[i].first -= count;
            if (bands.length === 0) bands.push({ first: 0, list: new RunList() });
            this.join(low, low);
        }
        return removed;
    }

    private bandAt(column: number): number {
        const { bands } = this;
        let low = 0;
        let high = bands.length;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (bands[middle].first <= column) low = middle;
            else high = middle;
        }
        return low;
    }

    // Writes the list of each band of the columns c0 to c1, cut at both ends first, then joins what became equal.
    private each(c0: number, c1: number, write: (list: RunList) => void): void {
        const low = this.split(c0);
        const high = this.split(c1 + 1);
        for (let i = low; i < high; i += 1) write(this.bands[i].list);
        this.join(low, high);
    }

    // The band that starts at `column`, cut from the band that holds the column when none does; the band count for
    // the column past the grid.
    private split(column: number): number {
        if (column >= GRID_COLUMNS) return this.bands.length;
        const at = this.bandAt(column);
        if (this.bands[at].first === column) return at;
        this.bands.splice(at + 1, 0, { first: column, list: this.bands[at].list.clone() });
        return at + 1;
    }

    // Drops each of the bands `low` to `high` that holds the list of the band before it.
    private join(low: number, high: number): void {
        const { bands } = this;
        const end = Math.min(high + 1, bands.length);
        let kept = Math.max(1, low);
        for (let i = kept; i < end; i += 1) {
            if (bands[i].list.equals(bands[kept - 1].list)) continue;
            bands[kept] = bands[i];
            kept += 1;
        }
        bands.splice(kept, end - kept);
    }
}
