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
    // `held` counts the runs and the bands of every sheet of the workbook: each write here adds what it changed.
    public constructor(
        flat: readonly number[],
        looks: readonly number[],
        private readonly held: { runs: number; bands: number },
    ) {
        const ids = [0, ...looks];
        for (let at = 0; at < flat.length; at += 2 + 2 * flat[at + 1]) {
            const runs: number[] = [];
            for (let i = at + 2; i < at + 2 + 2 * flat[at + 1]; i += 2) runs.push(flat[i], ids[flat[i + 1]]);
            const list = RunList.of(runs);
            const last = this.bands[this.bands.length - 1];
            if (flat[at] === 0) last.list = list;
            else if (!last.list.equals(list)) this.bands.push({ first: flat[at], list });
        }
        const { runs, bands } = this.weight();
        held.runs += runs;
        held.bands += bands;
    }

    public look(row: number, column: number): number {
        return this.bands[this.bandAt(column)].list.lookAt(row);
    }

    // The spans that tile a rectangle, plain ones included, in column order then row order.
    public *spans([top, left, bottom, right]: Rect): Generator<LookSpan> {
        const { bands } = this;
        for (let b = this.bandAt(left); b < bands.length && bands[b].first <= right; b += 1) {
            yield* this.under(b, top, left, bottom, right);
        }
    }

    // How many spans tile a rectangle: what a write over it reads.
    public tiles([top, left, bottom, right]: Rect): number {
        const { bands } = this;
        let tiles = 0;
        for (let b = this.bandAt(left); b < bands.length && bands[b].first <= right; b += 1) {
            const { list } = bands[b];
            tiles += list.runAt(bottom) - list.runAt(top) + 1;
        }
        return tiles;
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

    // What the limit on formats counts of this sheet, walked: the workbook's count is kept as the bands are written.
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

    // Every cell of the rectangles, which span the same columns, ascend and share no cell, wears `to` of the look it
    // wore. Returns the spans whose look changed. A band is cut and its list laid only where a look changes.
    public write(rects: readonly Rect[], to: (look: number) => number): LookSpan[] {
        const { bands } = this;
        const [, left, , right] = rects[0];
        const rows = rects.map(([top, , bottom]): Span => [top, bottom]);
        const replaced: LookSpan[] = [];
        let wrote = false;
        let b = this.bandAt(left);
        for (; b < bands.length && bands[b].first <= right; b += 1) {
            const before = replaced.length;
            for (const [top, bottom] of rows) {
                for (const span of this.under(b, top, left, bottom, right)) {
                    if (to(span.look) !== span.look) replaced.push(span);
                }
            }
            const writes = replaced.length > before;
            if (writes) {
                const { c0, c1 } = replaced[before];
                this.split(c1 + 1);
                b = this.split(c0);
                this.rewrite(bands[b].list, (list) => list.format(rows, to));
            }
            // A band joins the one before it when either was written.
            if (writes || wrote) b -= this.join(b, b);
            wrote = writes;
        }
        if (wrote) this.join(b, b);
        return replaced;
    }

    // The block leaves `source`, plain where it was, and lands here over what it returns: the spans it covered, as
    // they were before the move. Look ids are the workbook's, so a block crosses sheets as it is.
    public move({ from, toRow, toColumn }: MoveOp, source: Bands): LookSpan[] {
        const [top, left, bottom, right] = from;
        const rowShift = toRow - top;
        const columnShift = toColumn - left;
        const covered = [...this.spans([toRow, toColumn, bottom + rowShift, right + columnShift])];
        const spans = [...source.spans(from)];
        source.write([from], () => 0);
        let at = 0;
        while (at < spans.length) {
            // The spans of one band stand together: one cut of the columns writes them all, in one pass.
            const { c0, c1 } = spans[at];
            const first = at;
            while (at < spans.length && spans[at].c0 === c0) at += 1;
            const rows = spans.slice(first, at).map(({ r0, r1 }): Span => [r0 + rowShift, r1 + rowShift]);
            this.each(c0 + columnShift, c1 + columnShift, (list) => list.format(rows, (_, i) => spans[first + i].look));
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
            if (rows) for (const band of bands) this.rewrite(band.list, (list) => list.insertRows(index, count, like));
            else {
                // Beside the column `like` the new columns only widen its band.
                const from = like === index ? index + 1 : index;
                for (let i = bands.length - 1; i > 0 && bands[i].first >= from; i -= 1) bands[i].first += count;
                if (like < 0) this.each(index, last, (list) => list.format([[0, GRID_ROWS - 1]], () => 0));
            }
            return [];
        }
        const removed = [...this.spans(rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last])];
        if (rows) {
            for (const band of bands) this.rewrite(band.list, (list) => list.deleteRows(index, count));
            this.join(1, bands.length - 1);
        } else {
            const low = this.split(index);
            const high = this.split(index + count);
            const before = bands.length;
            for (const { list } of bands.splice(low, high - low)) this.held.runs -= list.count;
            for (let i = low; i < bands.length; i += 1) bands[i].first -= count;
            if (bands.length === 0) bands.push({ first: 0, list: new RunList() });
            this.held.bands += bands.length - before;
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

    // The spans of one band that tile the part of a rectangle in its columns, rows down, a list with no run as one.
    private *under(b: number, top: number, left: number, bottom: number, right: number): Generator<LookSpan> {
        const { bands } = this;
        const { first, list } = bands[b];
        const c0 = Math.max(left, first);
        const c1 = Math.min(right, (b + 1 < bands.length ? bands[b + 1].first : GRID_COLUMNS) - 1);
        if (list.count === 0) yield { c0, c1, r0: top, r1: bottom, look: 0 };
        for (let i = list.runAt(top); i < list.count && list.startOf(i) <= bottom; i += 1) {
            const end = i + 1 < list.count ? list.startOf(i + 1) : GRID_ROWS;
            yield { c0, c1, r0: Math.max(top, list.startOf(i)), r1: Math.min(bottom, end - 1), look: list.lookOf(i) };
        }
    }

    // Writes one list and adds the runs it gained or lost to the workbook's count.
    private rewrite(list: RunList, write: (list: RunList) => void): void {
        const before = list.count;
        write(list);
        this.held.runs += list.count - before;
    }

    // Writes the list of each band of the columns c0 to c1, cut at both ends first, then joins what became equal.
    private each(c0: number, c1: number, write: (list: RunList) => void): void {
        const low = this.split(c0);
        const high = this.split(c1 + 1);
        for (let i = low; i < high; i += 1) this.rewrite(this.bands[i].list, write);
        this.join(low, high);
    }

    // The band that starts at `column`, cut from the band that holds the column when none does; the band count for
    // the column past the grid.
    private split(column: number): number {
        if (column >= GRID_COLUMNS) return this.bands.length;
        const at = this.bandAt(column);
        const { first, list } = this.bands[at];
        if (first === column) return at;
        this.bands.splice(at + 1, 0, { first: column, list: list.clone() });
        this.held.runs += list.count;
        this.held.bands += 1;
        return at + 1;
    }

    // Drops each of the bands `low` to `high` that holds the list of the band before it, and says how many.
    private join(low: number, high: number): number {
        const { bands } = this;
        const end = Math.min(high + 1, bands.length);
        let kept = Math.max(1, low);
        for (let i = kept; i < end; i += 1) {
            if (bands[i].list.equals(bands[kept - 1].list)) {
                this.held.runs -= bands[i].list.count;
                continue;
            }
            bands[kept] = bands[i];
            kept += 1;
        }
        const dropped = Math.max(0, end - kept);
        bands.splice(kept, dropped);
        this.held.bands -= dropped;
        return dropped;
    }
}
