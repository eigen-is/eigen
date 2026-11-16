// What a cell of one sheet holds beyond the value the formula engine keeps for it: the runs of a rich text, a link,
// and the mark of a text typed with a leading quote. Few cells hold any, so they are kept by place in two parallel
// lists sorted in column order, as the engine walks its cells. The workbook holds one per sheet; its appliers write,
// fill, link and shift the entries as cells, lines and blocks change, and each write adds to the workbook's count. A
// rich cell's text is the engine's value of it, and `contentOf` joins the two into what an op says the cell holds.

import type { Literal } from '@workspace/formula';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { CellContent, LinesOp, MoveOp, Placed, Rect, Run } from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';

export type Extra = Readonly<Pick<CellContent, 's' | 'link' | 'qp'>>;

// The most items one spread hands a call.
const SPREAD = 65_536;

// A cell's place: its column times the grid's rows plus its row, so the places ascend in column order.
export function placeOf(row: number, column: number): number {
    return column * GRID_ROWS + row;
}

// The text a rich cell shows, which is the value the engine holds for it.
export function textOf(runs: readonly Run[]): string {
    return runs.map((run) => run.v).join('');
}

// What an op would say a cell holds, null for an empty cell: its rich runs in place of its value, which stands beside
// no formula or beside one whose value is given, an error as its text.
export function contentOf(
    value: Literal | null,
    formula: string | null,
    given: boolean,
    extra: Extra | undefined,
): CellContent | null {
    if (value === null && formula === null && extra === undefined) return null;
    const content: CellContent = {};
    if (extra?.s) content.s = extra.s;
    else if (formula === null || given) {
        if (typeof value === 'object' && value !== null) {
            content.v = value.text;
            content.e = 1;
        } else if (value !== null) content.v = value;
    }
    if (formula !== null) content.f = formula;
    if (extra?.link) content.link = extra.link;
    if (extra?.qp) content.qp = extra.qp;
    return content;
}

export class Extras {
    private places: number[] = [];
    private held: Extra[] = [];

    // `total` counts the units of the entries of every sheet of the workbook: each write here adds what it changed.
    public constructor(private readonly total: { extras: number }) {}

    // What the limits count of this sheet's entries, in units of `EXTRA_WEIGHT`, walked.
    public weight(): number {
        let units = 0;
        for (const extra of this.held) units += unitsOf(extra);
        return units;
    }

    public at(row: number, column: number): Extra | undefined {
        const place = placeOf(row, column);
        const at = this.search(place);
        return this.places[at] === place ? this.held[at] : undefined;
    }

    // The entries of a block in column order. It reads the lists as it goes, so nothing is written during a walk.
    public *cells([top, left, bottom, right]: Rect): Generator<Placed<Extra>> {
        let at = this.search(placeOf(top, left));
        while (at < this.places.length) {
            const row = this.places[at] % GRID_ROWS;
            const column = (this.places[at] - row) / GRID_ROWS;
            if (column > right) return;
            if (row < top) at = this.search(placeOf(top, column));
            else if (row > bottom) at = this.search(placeOf(top, column + 1));
            else {
                yield [row, column, this.held[at]];
                at += 1;
            }
        }
    }

    public content(): Placed<Extra>[] {
        return [...this.cells([0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1])];
    }

    // Puts what a cell holds in place of what it held, which is returned. A cell that holds none of the three has no
    // entry, so writing none deletes.
    public write(row: number, column: number, extra: Extra): Extra | undefined {
        const place = placeOf(row, column);
        const at = this.search(place);
        const old = this.places[at] === place ? this.held[at] : undefined;
        const replaced = old ? 1 : 0;
        const entry = entryOf(extra);
        this.total.extras += (entry ? unitsOf(entry) : 0) - (old ? unitsOf(old) : 0);
        if (entry) {
            this.places.splice(at, replaced, place);
            this.held.splice(at, replaced, entry);
        } else {
            this.places.splice(at, replaced);
            this.held.splice(at, replaced);
        }
        return old;
    }

    // Puts one entry in every cell of a block, or with none of the three empties it.
    public fill(rect: Rect, extra: Extra): void {
        const entry = entryOf(extra);
        this.merge([rect], () => entry);
    }

    // Sets the link of every cell of the rectangles, which share no cell, or with none clears it, each cell keeping its
    // runs and its mark.
    public link(rects: readonly Rect[], link: CellLink | undefined): void {
        this.merge(rects, (old) => entryOf({ ...old, link }));
    }

    // The block leaves `source`, empty where it was, and lands here over what it returns: the entries it covered, as
    // they were before the move.
    public move({ from, toRow, toColumn }: MoveOp, source: Extras): Placed<Extra>[] {
        const [top, left, bottom, right] = from;
        const target: Rect = [toRow, toColumn, toRow + bottom - top, toColumn + right - left];
        const covered = [...this.cells(target)];
        const block = source.take(from);
        this.take(target);
        const shift = placeOf(toRow, toColumn) - placeOf(top, left);
        const places: number[] = [];
        const held: Extra[] = [];
        let at = 0;
        // Both lists ascend, and a block shifted whole still does, so one pass merges them.
        for (const [row, column, extra] of block) {
            this.total.extras += unitsOf(extra);
            const place = placeOf(row, column) + shift;
            for (; at < this.places.length && this.places[at] < place; at += 1) {
                places.push(this.places[at]);
                held.push(this.held[at]);
            }
            places.push(place);
            held.push(extra);
        }
        for (; at < this.places.length; at += 1) {
            places.push(this.places[at]);
            held.push(this.held[at]);
        }
        this.places = places;
        this.held = held;
        return covered;
    }

    // Whether the insert would push an entry off the grid's end.
    public wouldPush({ rows, count }: LinesOp): boolean {
        const last = this.places.at(-1) ?? -1;
        if (!rows) return last >= placeOf(0, GRID_COLUMNS - count);
        return this.places.some((place) => place % GRID_ROWS >= GRID_ROWS - count);
    }

    // The new lines hold nothing. Returns the entries of the deleted lines, where they were.
    public lines({ rows, insert, index, count }: LinesOp): Placed<Extra>[] {
        const last = index + count - 1;
        const removed = insert
            ? []
            : this.take(rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last]);
        const shift = insert ? count : -count;
        const { places } = this;
        for (let at = 0; at < places.length; at += 1) {
            const row = places[at] % GRID_ROWS;
            if (rows ? row >= index : (places[at] - row) / GRID_ROWS >= index) {
                places[at] += rows ? shift : shift * GRID_ROWS;
            }
        }
        return removed;
    }

    // Puts in every cell of the rectangles, which share no cell, the entry `to` makes of the one it holds: the cells with
    // none all take `to` of none. The cells the rectangles change are found first, then one pass over the entries
    // between the first and the last puts them all in.
    private merge(rects: readonly Rect[], to: (old: Extra | undefined) => Extra | undefined): void {
        const blank = to(undefined);
        const changed: number[] = [];
        const entries: (Extra | undefined)[] = [];
        for (const rect of rects) {
            const cells = this.cells(rect);
            if (!blank) {
                for (const [row, column, old] of cells) {
                    changed.push(placeOf(row, column));
                    entries.push(to(old));
                }
                continue;
            }
            const [top, left, bottom, right] = rect;
            let next = cells.next();
            for (let column = left; column <= right; column += 1) {
                for (let row = top; row <= bottom; row += 1) {
                    const here = !next.done && next.value[0] === row && next.value[1] === column;
                    changed.push(placeOf(row, column));
                    entries.push(here ? to(next.value[2]) : blank);
                    if (here) next = cells.next();
                }
            }
        }
        if (changed.length === 0) return;
        // Each rectangle's cells come in place order, so the sort only merges them.
        const order = changed.map((_, at) => at).sort((a, b) => changed[a] - changed[b]);
        const start = this.search(changed[order[0]]);
        const end = this.search(changed[order[order.length - 1]] + 1);
        const places: number[] = [];
        const held: Extra[] = [];
        let at = start;
        for (const change of order) {
            const place = changed[change];
            for (; this.places[at] < place; at += 1) {
                places.push(this.places[at]);
                held.push(this.held[at]);
            }
            const old = this.places[at] === place ? this.held[at] : undefined;
            if (old) at += 1;
            const entry = entries[change];
            this.total.extras += (entry ? unitsOf(entry) : 0) - (old ? unitsOf(old) : 0);
            if (entry) {
                places.push(place);
                held.push(entry);
            }
        }
        // A spread passes its items as arguments, which an engine bounds, so a long span goes in by parts.
        for (let part = 0; part === 0 || part < places.length; part += SPREAD) {
            const removed = part === 0 ? end - start : 0;
            this.places.splice(start + part, removed, ...places.slice(part, part + SPREAD));
            this.held.splice(start + part, removed, ...held.slice(part, part + SPREAD));
        }
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
                this.total.extras -= unitsOf(held[at]);
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

// The entry of a cell that holds what is given, with only the keys it holds; none when it holds none of the three.
function entryOf({ s, link, qp }: Extra): Extra | undefined {
    if (!s && !link && !qp) return undefined;
    return Object.freeze({ ...(s && { s }), ...(link && { link }), ...(qp && { qp }) });
}

// What the limits count of what a cell holds beyond its value, nothing when it holds none of the three: an entry
// weighs two units, its place and its object, its link three more and each run of its text one. A unit is about the
// bytes one run of a rich text costs.
export function unitsOf({ s, link, qp }: Extra): number {
    return s || link || qp ? 2 + (link ? 3 : 0) + (s?.length ?? 0) : 0;
}
