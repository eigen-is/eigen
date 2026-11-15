// The line keys of one axis of one sheet: the size of a row or column, whether a person set it, and whether the line
// is hidden. Most lines have none, so they are kept as runs of neighbouring lines with equal keys, and a line with no
// key is in no run. The workbook holds one list for a sheet's rows and one for its columns; its appliers write the
// keys of a line format and shift the runs when lines are inserted or deleted. Two runs side by side never hold equal
// keys, so equal sheets are equal lists.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { LineAttrs, LinesOp, SheetContent, Span } from '@workspace/lib/sheets/ops';

type Run = { readonly first: number; last: number; readonly attrs: Readonly<LineAttrs> };

// The lines of a span with the keys they share, as a sheet's content lists them.
type LineRun = SheetContent['rows'][number];

const NO_KEYS: Readonly<LineAttrs> = Object.freeze({});
// Every line key once, in the order a run holds them: the mapped type fails the build on a key left out.
const LINE_KEY: { readonly [K in keyof LineAttrs]-?: K } = { size: 'size', custom: 'custom', hidden: 'hidden' };
const LINE_KEYS = Object.values(LINE_KEY);

export class LineRuns {
    private runs: Run[] = [];

    // The runs of a snapshot, ascending, which may say in two runs what one holds or list lines with no key.
    public constructor(content: SheetContent['rows']) {
        for (const [[first, last], attrs] of content) append(this.runs, first, last, keysOf(attrs));
    }

    public at(line: number): Readonly<LineAttrs> {
        const run = this.search(line);
        return run < this.runs.length && this.runs[run].first <= line ? this.runs[run].attrs : NO_KEYS;
    }

    public content(): LineRun[] {
        return this.runs.map(({ first, last, attrs }) => [[first, last], attrs]);
    }

    // Sets and clears keys on every line of the spans, which may overlap. Returns the keys those lines held, each
    // line once and the lines with no key included, in line order.
    public write(spans: readonly Span[], set: LineAttrs, clear: readonly (keyof LineAttrs)[]): LineRun[] {
        const before: LineRun[] = [];
        const next: Run[] = [];
        let line = 0;
        for (const span of spans.toSorted((a, b) => a[0] - b[0])) {
            const first = Math.max(span[0], line);
            if (first > span[1]) continue;
            for (const [[from, to], attrs] of this.tiles(line, first - 1)) append(next, from, to, attrs);
            for (const tile of this.tiles(first, span[1])) {
                const attrs = { ...tile[1], ...set };
                for (const key of clear) delete attrs[key];
                append(next, tile[0][0], tile[0][1], keysOf(attrs));
                before.push(tile);
            }
            line = span[1] + 1;
        }
        for (const [[from, to], attrs] of this.tiles(line, this.runs.at(-1)?.last ?? -1)) append(next, from, to, attrs);
        this.runs = next;
        return before;
    }

    // Whether the insert would push a line with a key off the grid's end.
    public wouldPush({ rows, count }: LinesOp): boolean {
        return (this.runs.at(-1)?.last ?? -1) >= (rows ? GRID_ROWS : GRID_COLUMNS) - count;
    }

    // The new lines hold no key, nor do the lines that enter at the grid's end on a delete. Returns the keys of the
    // deleted lines, where they were.
    public lines({ insert, index, count }: LinesOp): LineRun[] {
        const end = insert ? index : index + count;
        const shift = insert ? count : -count;
        const held = this.runs;
        const removed: LineRun[] = [];
        this.runs = [];
        for (const { first, last, attrs } of held) {
            if (first < index) append(this.runs, first, Math.min(last, index - 1), attrs);
            if (!insert && last >= index && first < end) {
                removed.push([[Math.max(first, index), Math.min(last, end - 1)], attrs]);
            }
            if (last >= end) append(this.runs, Math.max(first, end) + shift, last + shift, attrs);
        }
        return removed;
    }

    // The first run that ends at or after a line; the run count when none does.
    private search(line: number): number {
        let low = 0;
        let high = this.runs.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (this.runs[middle].last < line) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    // The lines `first` to `last`, cut where their keys change, the stretches with no key included.
    private *tiles(first: number, last: number): Generator<LineRun> {
        let line = first;
        for (let run = this.search(first); line <= last; run += 1) {
            const { first: start, last: end, attrs } = this.runs[run] ?? { first: last + 1, last, attrs: NO_KEYS };
            if (line < start) yield [[line, Math.min(start - 1, last)], NO_KEYS];
            if (start <= last) yield [[Math.max(start, line), Math.min(end, last)], attrs];
            line = end + 1;
        }
    }
}

// A run after every run of the list, joined to the last one when they touch and hold equal keys. Lines with no key
// make no run.
function append(runs: Run[], first: number, last: number, attrs: Readonly<LineAttrs>): void {
    if (attrs === NO_KEYS) return;
    const end = runs.at(-1);
    if (end && end.last + 1 === first && LINE_KEYS.every((key) => end.attrs[key] === attrs[key])) end.last = last;
    else runs.push({ first, last, attrs });
}

// The keys in one order and frozen, so a run's keys never change under whoever reads them.
function keysOf(attrs: LineAttrs): Readonly<LineAttrs> {
    const kept: LineAttrs = {};
    for (const key of LINE_KEYS) if (attrs[key] !== undefined) Object.assign(kept, { [key]: attrs[key] });
    return Object.keys(kept).length > 0 ? Object.freeze(kept) : NO_KEYS;
}
