import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Rect } from '@workspace/lib/sheets/ops';

// The model the bands are held to: a plain grid of look ids, one cell after another, with no runs and no bands. So
// that a few dozen lines reach the end of the real grid, line i of an axis stands for `heights[i]` (or `widths[i]`)
// equal neighbouring lines: `cut` makes any real line the first of its own group, which changes no cell.
export class LooksGrid {
    public heights = [GRID_ROWS];
    public widths = [GRID_COLUMNS];
    // cells[row group][column group]
    public cells: number[][] = [[0]];

    public clone(): LooksGrid {
        const copy = new LooksGrid();
        copy.heights = [...this.heights];
        copy.widths = [...this.widths];
        copy.cells = this.cells.map((row) => [...row]);
        return copy;
    }

    // The first real line of every group, then the grid's size.
    public starts(rows: boolean): number[] {
        const starts = [0];
        for (const size of rows ? this.heights : this.widths) starts.push(starts[starts.length - 1] + size);
        return starts;
    }

    // The group that starts at the real line `at`, cut from the group that holds it; the group count for the grid's end.
    public cut(rows: boolean, at: number): number {
        const sizes = rows ? this.heights : this.widths;
        let start = 0;
        for (let i = 0; i < sizes.length; i += 1) {
            if (start === at) return i;
            if (at < start + sizes[i]) {
                sizes.splice(i, 1, at - start, start + sizes[i] - at);
                this.add(rows, i + 1, this.line(rows, i));
                return i + 1;
            }
            start += sizes[i];
        }
        return sizes.length;
    }

    public look(row: number, column: number): number {
        const at = (starts: number[], line: number): number => starts.findLastIndex((start) => start <= line);
        return this.cells[at(this.starts(true), row)][at(this.starts(false), column)];
    }

    public format([top, left, bottom, right]: Rect, to: (look: number) => number): void {
        const r0 = this.cut(true, top);
        const r1 = this.cut(true, bottom + 1);
        const c0 = this.cut(false, left);
        const c1 = this.cut(false, right + 1);
        for (let r = r0; r < r1; r += 1) for (let c = c0; c < c1; c += 1) this.cells[r][c] = to(this.cells[r][c]);
    }

    // The new lines wear the looks of line `like`, or plain; the lines pushed past the grid's end are gone.
    public insert(rows: boolean, index: number, count: number, like: number): void {
        const sizes = rows ? this.heights : this.widths;
        const at = this.cut(rows, index);
        const looks = like < 0 ? this.plain(rows) : this.line(rows, like === index ? at : at - 1);
        sizes.splice(at, 0, count);
        this.add(rows, at, looks);
        const end = this.cut(rows, rows ? GRID_ROWS : GRID_COLUMNS);
        while (sizes.length > end) this.remove(rows, end);
    }

    // The lines that enter at the grid's end wear the looks of the last line that stays, or plain when none stays.
    public delete(rows: boolean, index: number, count: number): void {
        const sizes = rows ? this.heights : this.widths;
        const from = this.cut(rows, index);
        const to = this.cut(rows, index + count);
        for (let i = from; i < to; i += 1) this.remove(rows, from);
        const looks = sizes.length === 0 ? this.plain(rows) : this.line(rows, sizes.length - 1);
        sizes.push(count);
        this.add(rows, sizes.length - 1, looks);
    }

    // Whether one of the last `count` lines differs, in any cell, from the line before them (or from plain).
    public wouldPush(rows: boolean, count: number): boolean {
        const sizes = rows ? this.heights : this.widths;
        const at = this.cut(rows, (rows ? GRID_ROWS : GRID_COLUMNS) - count);
        const stays = at === 0 ? this.plain(rows) : this.line(rows, at - 1);
        for (let i = at; i < sizes.length; i += 1) {
            if (this.line(rows, i).some((look, j) => look !== stays[j])) return true;
        }
        return false;
    }

    // The cells of `rect` on `from` land here with their top left at (toRow, toColumn), cell by cell.
    public paste(from: LooksGrid, [top, left, bottom, right]: Rect, toRow: number, toColumn: number): void {
        for (const start of from.starts(true)) if (start > top && start <= bottom) this.cut(true, start - top + toRow);
        for (const start of from.starts(false)) {
            if (start > left && start <= right) this.cut(false, start - left + toColumn);
        }
        const r0 = this.cut(true, toRow);
        const r1 = this.cut(true, toRow + bottom - top + 1);
        const c0 = this.cut(false, toColumn);
        const c1 = this.cut(false, toColumn + right - left + 1);
        const rowStarts = this.starts(true);
        const columnStarts = this.starts(false);
        for (let r = r0; r < r1; r += 1) {
            for (let c = c0; c < c1; c += 1) {
                this.cells[r][c] = from.look(rowStarts[r] - toRow + top, columnStarts[c] - toColumn + left);
            }
        }
    }

    // Joins the neighbouring groups that hold equal looks, which changes no cell, so the grid stays small.
    public tidy(): void {
        for (const rows of [true, false]) {
            const sizes = rows ? this.heights : this.widths;
            for (let i = sizes.length - 1; i > 0; i -= 1) {
                const before = this.line(rows, i - 1);
                if (this.line(rows, i).some((look, j) => look !== before[j])) continue;
                sizes[i - 1] += sizes[i];
                this.remove(rows, i);
            }
        }
    }

    // The bands this grid asks for, built column by column: the flat form `[first column, n, (start row, look) × n]`
    // with look ids in place of look indices. `joined` false keeps every group as its own run and band, which is the
    // same sheet said with more entries than it needs.
    public flat(joined: boolean): number[] {
        const rowStarts = this.starts(true);
        const columnStarts = this.starts(false);
        const flat: number[] = [];
        let previous: number[] | null = null;
        for (let c = 0; c < this.widths.length; c += 1) {
            let runs: number[] = [];
            for (let r = 0; r < this.heights.length; r += 1) {
                const look = this.cells[r][c];
                if (!joined || runs.length === 0 || runs[runs.length - 1] !== look) runs.push(rowStarts[r], look);
            }
            if (joined && runs.length === 2 && runs[1] === 0) runs = [];
            const list = runs;
            if (
                joined &&
                previous !== null &&
                previous.length === list.length &&
                previous.every((n, i) => n === list[i])
            ) {
                continue;
            }
            flat.push(columnStarts[c], runs.length / 2, ...runs);
            previous = runs;
        }
        return flat;
    }

    // What `extent()` must say: per axis, where the last stretch of equal lines starts when it is styled, and the line
    // before it when it is plain.
    public extent(): { lastRow: number; lastColumn: number } {
        let lastRow = -1;
        const rowStarts = this.starts(true);
        for (let c = 0; c < this.widths.length; c += 1) {
            let r = this.heights.length - 1;
            while (r > 0 && this.cells[r - 1][c] === this.cells[r][c]) r -= 1;
            lastRow = Math.max(lastRow, this.cells[r][c] === 0 ? rowStarts[r] - 1 : rowStarts[r]);
        }
        let c = this.widths.length - 1;
        while (c > 0 && this.cells.every((row) => row[c - 1] === row[c])) c -= 1;
        const lastColumn = this.cells.every((row) => row[c] === 0) ? this.starts(false)[c] - 1 : this.starts(false)[c];
        return { lastRow, lastColumn };
    }

    private plain(rows: boolean): number[] {
        return (rows ? this.widths : this.heights).map(() => 0);
    }

    // The looks along group `i`, a copy.
    private line(rows: boolean, i: number): number[] {
        return rows ? [...this.cells[i]] : this.cells.map((row) => row[i]);
    }

    // The cells of a group at `i`; its size is the caller's to set.
    private add(rows: boolean, i: number, looks: number[]): void {
        if (rows) this.cells.splice(i, 0, looks);
        else for (const [r, row] of this.cells.entries()) row.splice(i, 0, looks[r]);
    }

    private remove(rows: boolean, i: number): void {
        (rows ? this.heights : this.widths).splice(i, 1);
        if (rows) this.cells.splice(i, 1);
        else for (const row of this.cells) row.splice(i, 1);
    }
}
