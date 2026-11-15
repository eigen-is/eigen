// What a cell of one sheet holds beyond the value the formula engine keeps for it: the runs of a rich text, a link,
// and the mark of a text typed with a leading quote. Few cells hold any, so they are kept by place in two parallel
// lists sorted in column order, as the engine walks its cells. The workbook holds one per sheet; its appliers write,
// fill and shift the entries as cells, lines and blocks change, the weight kept as they go. A rich cell's text is the
// engine's value of it, and `contentOf` joins the two into what an op says the cell holds.

import type { Literal } from '@workspace/formula';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { CellContent, LinesOp, MoveOp, Placed, Rect, Run } from '@workspace/lib/sheets/ops';

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
    private units = 0;

    // What the limits count of the entries, in units of `EXTRA_WEIGHT`.
    public weight(): number {
        return this.units;
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
        this.units += (entry ? unitsOf(entry) : 0) - (old ? unitsOf(old) : 0);
        if (entry) {
            this.places.splice(at, replaced, place);
            this.held.splice(at, replaced, entry);
        } else {
            this.places.splice(at, replaced);
            this.held.splice(at, replaced);
        }
        return old;
    }

    // Puts one entry in every cell of a block, or with none of the three empties it, in one pass over the entries
    // between the block's first place and its last.
    public fill([top, left, bottom, right]: Rect, extra: Extra): void {
        const entry = entryOf(extra);
        const start = this.search(placeOf(top, left));
        const end = this.search(placeOf(bottom, right) + 1);
        const places: number[] = [];
        const held: Extra[] = [];
        let column = left;
        // Lays the block's columns that start before a place, as the merge reaches it.
        const lay = (before: number) => {
            for (; entry && column <= right && placeOf(top, column) < before; column += 1) {
                for (let row = top; row <= bottom; row += 1) {
                    places.push(placeOf(row, column));
                    held.push(entry);
                }
            }
        };
        for (let at = start; at < end; at += 1) {
            const row = this.places[at] % GRID_ROWS;
            if (row >= top && row <= bottom) {
                this.units -= unitsOf(this.held[at]);
                continue;
            }
            lay(this.places[at]);
            places.push(this.places[at]);
            held.push(this.held[at]);
        }
        lay(Number.POSITIVE_INFINITY);
        if (entry) this.units += unitsOf(entry) * (bottom - top + 1) * (right - left + 1);
        // A spread passes its items as arguments, which an engine bounds, so a long span goes in by parts.
        for (let at = 0; at === 0 || at < places.length; at += SPREAD) {
            const removed = at === 0 ? end - start : 0;
            this.places.splice(start + at, removed, ...places.slice(at, at + SPREAD));
            this.held.splice(start + at, removed, ...held.slice(at, at + SPREAD));
        }
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
            this.units += unitsOf(extra);
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

    // Takes the entries of a block out and returns them, in column order.
    private take([top, left, bottom, right]: Rect): Placed<Extra>[] {
        const { places, held } = this;
        const taken: Placed<Extra>[] = [];
        let kept = 0;
        for (let at = 0; at < places.length; at += 1) {
            const row = places[at] % GRID_ROWS;
            const column = (places[at] - row) / GRID_ROWS;
            if (row >= top && row <= bottom && column >= left && column <= right) {
                this.units -= unitsOf(held[at]);
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

// An entry weighs two units, its place and its object, its link three more and each run of its text one: a unit is
// about the bytes one run of a rich text costs.
function unitsOf({ s, link }: Extra): number {
    return 2 + (link ? 3 : 0) + (s?.length ?? 0);
}
