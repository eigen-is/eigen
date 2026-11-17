// What a cell of one sheet holds beyond the value the formula engine keeps for it: the runs of a rich text, a link,
// and the mark of a text typed with a leading quote. Few cells hold any, so they are kept by place in two parallel
// lists sorted in column order, as the engine walks its cells. The workbook holds one per sheet; its appliers write,
// fill, link and shift the entries as cells, lines and blocks change, and each write adds to the workbook's count. A
// rich cell's text is the engine's value of it, and `contentOf` joins the two into what an op says the cell holds.

import type { Literal } from '@workspace/formula';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { CellContent, LinesOp, MoveOp, Placed, Rect, Run } from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';
import { ColumnSweep } from './rect-index';

export type Extra = Readonly<Pick<CellContent, 's' | 'link' | 'qp'>>;

// A cell's place: its column times the grid's rows plus its row, so the places ascend in column order.
function placeOf(row: number, column: number): number {
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

    // The entries of a block in column order.
    public cells(rect: Rect): Placed<Extra>[] {
        const found: Placed<Extra>[] = [];
        this.within(new ColumnSweep([rect]), (row, column, extra) => found.push([row, column, extra]));
        return found;
    }

    // Tells `visit`, which must not write here, the entries of the rectangles a sweep covers in column order, each with
    // its rectangle's place in the list. Down a column an entry stays in the rectangle before while it can.
    public within(sweep: ColumnSweep, visit: (row: number, column: number, extra: Extra, at: number) => void): void {
        const { rects, live } = sweep;
        sweep.pass((left, right) => {
            const first = rects[live[0]][0];
            let at = this.search(placeOf(first, left));
            // The column of the last entry handed out, and the place in `live` of its rectangle.
            let column = -1;
            let block = 0;
            while (at < this.places.length) {
                const row = this.places[at] % GRID_ROWS;
                const next = (this.places[at] - row) / GRID_ROWS;
                if (next > right) break;
                if (next !== column || row > rects[live[block]][2]) block = sweep.after(row) - 1;
                if (block >= 0 && rects[live[block]][2] >= row) {
                    column = next;
                    visit(row, column, this.held[at], live[block]);
                    at += 1;
                } else {
                    column = -1;
                    const below = block + 1 < live.length ? rects[live[block + 1]][0] : -1;
                    at = this.search(below < 0 ? placeOf(first, next + 1) : placeOf(below, next));
                }
            }
        });
    }

    public content(): Placed<Extra>[] {
        return this.cells([0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1]);
    }

    // Puts what a cell holds in place of what it held. A cell that holds none of the three has no entry, so writing
    // none deletes.
    public write(row: number, column: number, extra: Extra): void {
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
    }

    // Puts in every cell of each rectangle the sweep covers the one entry at its place in `extras`, or with none of the
    // three empties it.
    public fill(sweep: ColumnSweep, extras: readonly Extra[]): void {
        const entries = extras.map(entryOf);
        this.merge(sweep, (_, at) => entries[at]);
    }

    // Sets the link of every cell of the rectangles the sweep covers, or with none clears it, each cell keeping its runs
    // and its mark.
    public link(sweep: ColumnSweep, link: CellLink | undefined): void {
        this.merge(sweep, (old) => entryOf({ ...old, link }));
    }

    // The block leaves `source`, empty where it was, and lands here over what it covered.
    public move({ from, toRow, toColumn }: MoveOp, source: Extras): void {
        const [top, left, bottom, right] = from;
        const target: Rect = [toRow, toColumn, toRow + bottom - top, toColumn + right - left];
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
    }

    // Whether the insert would push an entry off the grid's end.
    public wouldPush({ rows, count }: LinesOp): boolean {
        const last = this.places.at(-1) ?? -1;
        if (!rows) return last >= placeOf(0, GRID_COLUMNS - count);
        return this.places.some((place) => place % GRID_ROWS >= GRID_ROWS - count);
    }

    // The new lines hold nothing, and the entries of deleted lines go with them.
    public lines({ rows, insert, index, count }: LinesOp): void {
        const last = index + count - 1;
        if (!insert) this.take(rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last]);
        const shift = insert ? count : -count;
        const { places } = this;
        for (let at = 0; at < places.length; at += 1) {
            const row = places[at] % GRID_ROWS;
            if (rows ? row >= index : (places[at] - row) / GRID_ROWS >= index) {
                places[at] += rows ? shift : shift * GRID_ROWS;
            }
        }
    }

    // Puts in every cell of the rectangles the sweep covers the entry `to` makes of the one it holds and of the
    // rectangle's place in the list: the cells with none all take `to` of none. The cells the rectangles change are
    // found first; then each stretch of them with no untouched entry between is laid anew, and the entries between
    // stretches move whole, as a run list moves its runs.
    private merge(sweep: ColumnSweep, to: (old: Extra | undefined, at: number) => Extra | undefined): void {
        const { rects } = sweep;
        // The cells changed, each with its rectangle's place: a rectangle whose empty cells stay empty changes only the
        // cells that hold an entry, which one walk reads for all; the others change every cell.
        const changed: number[] = [];
        const owners: number[] = [];
        const blanks = rects.map((_, at) => to(undefined, at));
        this.within(sweep, (row, column, _, at) => {
            if (blanks[at] === undefined) {
                changed.push(placeOf(row, column));
                owners.push(at);
            }
        });
        for (const [at, [top, left, bottom, right]] of rects.entries()) {
            if (blanks[at] === undefined) continue;
            for (let column = left; column <= right; column += 1) {
                for (let row = top; row <= bottom; row += 1) {
                    changed.push(placeOf(row, column));
                    owners.push(at);
                }
            }
        }
        const order = changed.map((_, at) => at).sort((a, b) => changed[a] - changed[b]);
        const { places, held } = this;
        const size = places.length;
        const laid: number[] = [];
        const laidHeld: Extra[] = [];
        const stretches: { first: number; after: number; from: number; until: number; shift: number }[] = [];
        let shift = 0;
        for (let change = 0; change < order.length; ) {
            const first = this.search(changed[order[change]]);
            const from = laid.length;
            let after = first;
            for (; change < order.length; change += 1) {
                const place = changed[order[change]];
                if (after < size && places[after] < place) break;
                const old = places[after] === place ? held[after] : undefined;
                if (old) after += 1;
                const entry = old ? to(old, owners[order[change]]) : blanks[owners[order[change]]];
                this.total.extras += (entry ? unitsOf(entry) : 0) - (old ? unitsOf(old) : 0);
                if (entry) {
                    laid.push(place);
                    laidHeld.push(entry);
                }
            }
            shift += laid.length - from - (after - first);
            stretches.push({ first, after, from, until: laid.length, shift });
        }
        if (shift > 0) for (const list of [places, held]) list.length = size + shift;
        // The entries after a stretch, up to the next one, move by its shift: those that move back first, in order,
        // then those that move on, from the last, so none is written over before it moved.
        const slide = (at: number) => {
            const { after, shift } = stretches[at];
            const end = stretches[at + 1]?.first ?? size;
            places.copyWithin(after + shift, after, end);
            held.copyWithin(after + shift, after, end);
        };
        for (let at = 0; at < stretches.length; at += 1) if (stretches[at].shift < 0) slide(at);
        for (let at = stretches.length - 1; at >= 0; at -= 1) if (stretches[at].shift > 0) slide(at);
        // A stretch's entries land where its first one went, moved by the stretches before it.
        let moved = 0;
        for (const { first, from, until, shift } of stretches) {
            for (let k = from; k < until; k += 1) {
                places[first + moved + k - from] = laid[k];
                held[first + moved + k - from] = laidHeld[k];
            }
            moved = shift;
        }
        for (const list of [places, held]) list.length = size + shift;
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
