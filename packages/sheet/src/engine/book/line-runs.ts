// The line keys of one axis of one sheet: the size of a row or column, whether a person set it, and whether the line
// is hidden. Most lines have none, so they are kept as runs of neighbouring lines with equal keys, and a line with no
// key is in no run. The workbook holds one list for a sheet's rows and one for its columns; its appliers write the
// keys of a line format and shift the runs when lines are inserted or deleted. Two runs side by side never hold equal
// keys, so equal sheets are equal lists.

import type { LineAttrs, SheetContent, Span } from '@workspace/lib/sheets/ops';

type Run = { readonly first: number; last: number; readonly attrs: Readonly<LineAttrs> };

// The lines of a span with the keys they share, as a sheet's content lists them.
type LineRun = [Span, Readonly<LineAttrs>];

const NO_KEYS: Readonly<LineAttrs> = Object.freeze({});

export class LineRuns {
    private runs: Run[] = [];

    // The runs of a snapshot, ascending, which may say in two runs what one holds or list lines with no key.
    public constructor(content: SheetContent['rows'] = []) {
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

    // The new lines hold no key. The caller refused an insert that pushes a line with a key off the grid's end.
    public insert(index: number, count: number): void {
        const held = this.runs;
        this.runs = [];
        for (const { first, last, attrs } of held) {
            if (first < index) append(this.runs, first, Math.min(last, index - 1), attrs);
            if (last >= index) append(this.runs, Math.max(first, index) + count, last + count, attrs);
        }
    }

    // Returns the keys of the deleted lines, where they were. The lines that enter at the grid's end hold none.
    public remove(index: number, count: number): LineRun[] {
        const end = index + count;
        const held = this.runs;
        const removed: LineRun[] = [];
        this.runs = [];
        for (const { first, last, attrs } of held) {
            if (first < index) append(this.runs, first, Math.min(last, index - 1), attrs);
            if (last >= index && first < end) removed.push([[Math.max(first, index), Math.min(last, end - 1)], attrs]);
            if (last >= end) append(this.runs, Math.max(first, end) - count, last - count, attrs);
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
    const joins =
        end !== undefined &&
        end.last + 1 === first &&
        end.attrs.size === attrs.size &&
        end.attrs.custom === attrs.custom &&
        end.attrs.hidden === attrs.hidden;
    if (joins) end.last = last;
    else runs.push({ first, last, attrs });
}

// The keys in one order and frozen, so a run's keys never change under whoever reads them.
function keysOf({ size, custom, hidden }: LineAttrs): Readonly<LineAttrs> {
    if (size === undefined && custom === undefined && hidden === undefined) return NO_KEYS;
    const attrs: LineAttrs = {};
    if (size !== undefined) attrs.size = size;
    if (custom !== undefined) attrs.custom = custom;
    if (hidden !== undefined) attrs.hidden = hidden;
    return Object.freeze(attrs);
}
