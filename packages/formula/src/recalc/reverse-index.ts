// The reverse index of a workbook: which formulas read a cell, which a marking follows from the written cells, and
// which blocks of formulas read a sheet, which the plan of an edit visits. It holds every sheet's blocks of cells of
// one shape, each filed under what it reads, and per sheet that is read a `Listing` of about one entry per reference.
// Nothing here is patched or holds the place of a sheet: once a sheet is forgotten or reshaped its blocks are found
// again in its columns and filed again, and the listing of every sheet they read or did read is built again whole.

import { sheetOf } from '../edit/leaves';
import { Fact } from '../eval/facts';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { FormulaNode } from '../text/tree';
import { RefFlag, RefKind, SheetKind } from '../text/tree';
import { flag, Listing, RANGE } from './listing';

// What a block reads: a sheet, by its id, or what no reference names, by the fact of its shape that says so.
type Key = string | number;

// What the listing of one sheet is made of: the sheets of the hosts, the entries, and what each entry reads of the
// sheet: first and last row, first and last column, and where the entry starts.
type Listed = { readonly hosts: Sheet[]; readonly entries: number[]; readonly areas: number[] };

type Held = { readonly blocks: readonly number[]; readonly filed: ReadonlyMap<Key, readonly number[]> };

// What a block reads whose shape names a sheet by a name no sheet has, or a span of sheets: the tabs themselves, as
// a sheet that comes, goes, moves or gets another name can change what it reads.
export const TABS = 0;

// The facts of a shape that say it reads what no reference names.
const FACTS = [Fact.ReadsUnnamed, Fact.Resolves, Fact.Clock];

export class ReverseIndex {
    // The spans a marking has still to follow: sheet, column, first and last row.
    private readonly work: number[] = [];
    // Per sheet that is read, by its id, whether a sheet has it or not: what the references of the shapes read of
    // it, and what the formulas resolved into it when they were last computed.
    private readonly named = new Map<string, Listing>();
    private recorded = new Map<string, Listing>();
    // Per sheet, its blocks as they were last found in its columns, in the order of their first column: first and
    // last column, first and last row, and shape. And per thing they read, where the blocks that read it start.
    private readonly held = new WeakMap<Sheet, Held>();
    // Per thing read, the sheets with a block that reads it.
    private readonly readers = new Map<Key, Set<Sheet>>();
    // The sheets whose formulas changed since the last rebuild, and whether they came, went or moved: else they
    // only got another shape where they are.
    private readonly changed = new Map<Sheet, boolean>();
    // Per shape, how many blocks hold it.
    private readonly holders: number[] = [];

    public get stale(): boolean {
        return this.changed.size > 0;
    }

    // Formulas of a sheet came, went or moved, or the sheet did: the next rebuild reads all its columns.
    public forget(sheet: Sheet): void {
        this.changed.set(sheet, true);
    }

    // Formulas of a sheet got another shape where they are: the next rebuild reads the columns of its blocks.
    public reshape(sheet: Sheet): void {
        this.changed.set(sheet, this.changed.get(sheet) === true);
    }

    // Finds the blocks of the changed sheets in their columns, files them, and lists again who reads each sheet
    // they read or did read. Then the shape table forgets the shapes no block holds, as a rewritten formula leaves.
    public rebuild(workbook: Workbook, factsOf: (shape: number) => number): void {
        const { shapes } = workbook;
        const { holders, readers } = this;
        while (holders.length <= shapes.size) holders.push(0);
        // The table is asked which shapes no block holds when it gave out an id, or a sheet that held formulas changed.
        let unheld = shapes.added;
        const relist = new Set<string>();
        // Per sheet to list again, what its listing is made of, which the changed sheets enter first.
        const lists = new Map<string, Listed>();
        for (const [sheet, whole] of this.changed) {
            const had = this.held.get(sheet);
            const old = had?.blocks ?? [];
            if (old.length > 0) unheld = true;
            for (let b = 4; b < old.length; b += 5) holders[old[b]] -= 1;
            for (const key of had?.filed.keys() ?? []) {
                readers.get(key)?.delete(sheet);
                if (typeof key === 'string') relist.add(key);
            }
            // A sheet that is gone, or that an edit refused to add, holds no block.
            if (workbook.sheet(sheet.id) !== sheet) {
                this.held.delete(sheet);
                continue;
            }
            const blocks = this.found(sheet, whole ? undefined : had?.blocks);
            for (let b = 4; b < blocks.length; b += 5) holders[blocks[b]] += 1;
            const filed = this.filed(sheet, blocks, workbook, factsOf, lists);
            this.held.set(sheet, { blocks, filed });
            for (const key of filed.keys()) {
                const hosts = readers.get(key);
                if (hosts === undefined) readers.set(key, new Set([sheet]));
                else hosts.add(sheet);
                if (typeof key === 'string') relist.add(key);
            }
        }
        for (const id of relist) {
            const list = lists.get(id) ?? { hosts: [], entries: [], areas: [] };
            for (const host of readers.get(id) ?? []) {
                // A changed sheet entered what it reads as it was filed.
                if (this.changed.has(host)) continue;
                const { blocks = [], filed } = this.held.get(host) ?? {};
                for (const b of filed?.get(id) ?? []) {
                    if (shapes.facts[blocks[b + 4]] & Fact.Kept) continue;
                    for (const ref of shapes.shape(blocks[b + 4]).refs) {
                        if (sheetOf(ref, host.id) === id) this.enter(list, host, blocks, b, ref);
                    }
                }
            }
            if (readers.get(id)?.size === 0) readers.delete(id);
            if (list.entries.length === 0) this.named.delete(id);
            else this.named.set(id, new Listing(this.work, list.hosts, list.entries, list.areas));
        }
        this.changed.clear();
        if (unheld) {
            const held = new Uint8Array(shapes.size + 1);
            for (let shape = 1; shape <= shapes.size; shape += 1) held[shape] = holders[shape] > 0 ? 1 : 0;
            shapes.keep(held);
        }
    }

    // The blocks of `sheets` and the blocks of any sheet that read one of `keys`, each once, in the order of the
    // sheets and of their first column: the place of the sheet, first and last column, first and last row, and shape.
    public reading(sheets: readonly Sheet[], keys: readonly Key[]): number[] {
        // Per sheet, where the blocks start in its list, and for one of `sheets` nothing: all of them.
        const found = new Map<Sheet, readonly number[] | undefined>();
        for (const key of new Set(keys)) {
            for (const host of this.readers.get(key) ?? []) {
                const starts = this.held.get(host)?.filed.get(key) ?? [];
                const before = found.get(host);
                found.set(host, before === undefined ? starts : [...before, ...starts].sort((a, b) => a - b));
            }
        }
        for (const sheet of sheets) found.set(sheet, undefined);
        const rectangles: number[] = [];
        for (const host of [...found.keys()].sort((a, b) => a.place - b.place)) {
            const blocks = this.held.get(host)?.blocks ?? [];
            const starts = found.get(host);
            const count = starts?.length ?? blocks.length / 5;
            for (let i = 0, last = -1; i < count; i += 1) {
                const b = starts === undefined ? i * 5 : starts[i];
                if (b === last) continue;
                last = b;
                rectangles.push(host.place, blocks[b], blocks[b + 1], blocks[b + 2], blocks[b + 3], blocks[b + 4]);
            }
        }
        return rectangles;
    }

    // Lists the boxes of the records: per column of a formula, as the place of its sheet times the columns of the
    // grid plus its own, and per row, five numbers a box, the place of its sheet first.
    public listRecords(
        sheets: readonly Sheet[],
        records: ReadonlyMap<number, ReadonlyMap<number, readonly number[]>>,
    ): void {
        // Per sheet that is read, by its place: the entries, and what each reads of it.
        const read = new Map<number, [entries: number[], areas: number[]]>();
        for (const [at, rows] of records) {
            const s = Math.floor(at / GRID_COLUMNS);
            const c = at % GRID_COLUMNS;
            for (const [row, record] of rows) {
                for (let a = 0; a < record.length; a += 5) {
                    const top = record[a + 1];
                    const left = record[a + 2];
                    const bottom = record[a + 3];
                    const right = record[a + 4];
                    let lists = read.get(record[a]);
                    if (lists === undefined) read.set(record[a], (lists = [[], []]));
                    lists[1].push(top, bottom, left, right, lists[0].length);
                    // As a range, so that a marking is done with the entry once its cell is flagged.
                    lists[0].push(s, row, row, c, c, top, bottom, left, right, RANGE, 0, -1);
                }
            }
        }
        this.recorded = new Map();
        for (const [place, [entries, areas]] of read) {
            this.recorded.set(sheets[place].id, new Listing(this.work, sheets, entries, areas));
        }
    }

    // Flags every formula that reads a seed or a formula flagged here, each once, and every formula that asks
    // the workbook itself; with `resolving`, every formula that works a reference out too, as no record says what
    // they read. A seed is a span of rows: sheet, column, first and last row.
    public mark(workbook: Workbook, seeds: readonly number[], resolving: boolean): void {
        const { sheets } = workbook;
        const { work } = this;
        for (const seed of seeds) work.push(seed);
        for (const fact of resolving ? [Fact.ReadsUnnamed, Fact.Resolves] : [Fact.ReadsUnnamed]) {
            for (const host of this.readers.get(fact) ?? []) {
                const { blocks = [], filed } = this.held.get(host) ?? {};
                for (const b of filed?.get(fact) ?? []) {
                    for (let c = blocks[b]; c <= blocks[b + 1]; c += 1) {
                        flag(work, host.place, c, host.columns[c], blocks[b + 2], blocks[b + 3]);
                    }
                }
            }
        }
        // The listings of the sheet the last span lay on, which most spans share with the one before.
        let on = -1;
        let named: Listing | undefined;
        let recorded: Listing | undefined;
        const followed = new Set<Listing>();
        while (work.length > 0) {
            const span = work.length - 4;
            const sheet = work[span];
            const column = work[span + 1];
            const from = work[span + 2];
            const to = work[span + 3];
            work.length = span;
            if (sheet !== on) {
                on = sheet;
                named = this.named.get(sheets[sheet].id);
                recorded = this.recorded.get(sheets[sheet].id);
                if (named !== undefined) followed.add(named);
                if (recorded !== undefined) followed.add(recorded);
            }
            named?.follow(column, from, to);
            recorded?.follow(column, from, to);
        }
        for (const listing of followed) listing.restore();
    }

    // The blocks of a sheet as its columns hold them. Formulas that only got another shape lie in the columns of the
    // blocks the sheet had: given those as `kept`, no other column is read.
    private found(sheet: Sheet, kept: readonly number[] | undefined): number[] {
        const blocks: number[] = [];
        const { columns } = sheet;
        // Of the blocks whose columns are read, the first one that reaches the column or lies past it.
        let h = 0;
        // The runs of the column before, from the top down: first row, last row, shape, and where in the
        // list its block starts. The two lists swap from column to column.
        let open: number[] = [];
        let runs: number[] = [];
        let opened = 0;
        for (let c = 0; c < columns.length; c += 1) {
            if (kept !== undefined) {
                while (h < kept.length && kept[h + 1] < c) h += 5;
                if (h === kept.length) break;
                // The columns up to that block hold no formula, so no run of them goes on.
                if (kept[h] > c) {
                    c = kept[h];
                    opened = 0;
                }
            }
            const { shape, length } = columns[c];
            let ran = 0;
            let o = 0;
            let row = 0;
            while (row < length) {
                const id = shape[row];
                const first = row;
                row += 1;
                if (id === 0) continue;
                while (row < length && shape[row] === id) row += 1;
                while (o < opened && open[o] < first) o += 4;
                const joins = o < opened && open[o] === first && open[o + 1] === row - 1 && open[o + 2] === id;
                runs[ran] = first;
                runs[ran + 1] = row - 1;
                runs[ran + 2] = id;
                runs[ran + 3] = joins ? open[o + 3] : blocks.length;
                ran += 4;
                if (joins) blocks[open[o + 3] + 1] = c;
                else blocks.push(c, c, first, row - 1, id);
            }
            const before = open;
            open = runs;
            runs = before;
            opened = ran;
        }
        return blocks;
    }

    // The blocks of a sheet under each thing they read, as where they start in its list. What their references read
    // of a sheet is entered in the list of that sheet.
    private filed(
        sheet: Sheet,
        blocks: readonly number[],
        { shapes }: Workbook,
        factsOf: (shape: number) => number,
        lists: Map<string, Listed>,
    ): Map<Key, number[]> {
        const filed = new Map<Key, number[]>();
        // Most blocks of a sheet read what the block before read, its own sheet.
        let last: Key = TABS;
        let starts: number[] = [];
        const file = (key: Key, b: number) => {
            if (key !== last || starts.length === 0) {
                last = key;
                starts = filed.get(key) ?? [];
                filed.set(key, starts);
            }
            if (starts[starts.length - 1] !== b) starts.push(b);
        };
        for (let b = 0; b < blocks.length; b += 5) {
            const facts = factsOf(blocks[b + 4]);
            const { refs, namesSheet } = shapes.shape(blocks[b + 4]);
            // A formula this build cannot evaluate is computed by no pass, but an edit rewrites it like any.
            for (const fact of FACTS) if ((facts & (fact | Fact.Kept)) === fact) file(fact, b);
            if (namesSheet) file(TABS, b);
            for (const ref of refs) {
                const read = sheetOf(ref, sheet.id);
                if (read === null) {
                    if (ref.sheetKind === SheetKind.Span) file(TABS, b);
                    continue;
                }
                file(read, b);
                if (facts & Fact.Kept) continue;
                let list = lists.get(read);
                if (list === undefined) lists.set(read, (list = { hosts: [], entries: [], areas: [] }));
                this.enter(list, sheet, blocks, b, ref);
            }
        }
        return filed;
    }

    // Enters what one reference of a block reads into the list of the sheet it reads: about one entry.
    private enter(
        { hosts, entries, areas }: Listed,
        host: Sheet,
        blocks: readonly number[],
        b: number,
        ref: FormulaNode,
    ): void {
        if (hosts[hosts.length - 1] !== host) hosts.push(host);
        // Each end as where it sits for a host at 0 and how far it moves with the host, 0 or 1.
        let { row, row2, column, column2 } = ref;
        const { op, flags } = ref;
        let rowStep = flags & RefFlag.RowAbsolute ? 0 : 1;
        let row2Step = flags & RefFlag.Row2Absolute ? 0 : 1;
        let columnStep = flags & RefFlag.ColumnAbsolute ? 0 : 1;
        let column2Step = flags & RefFlag.Column2Absolute ? 0 : 1;
        if (op === RefKind.Cell) {
            row2 = row;
            row2Step = rowStep;
            column2 = column;
            column2Step = columnStep;
        } else if (op === RefKind.Columns) {
            row = 0;
            row2 = GRID_ROWS - 1;
            rowStep = 0;
            row2Step = 0;
        } else if (op === RefKind.Rows) {
            column = 0;
            column2 = GRID_COLUMNS - 1;
            columnStep = 0;
            column2Step = 0;
        }
        // A host at which the reference leaves the grid reads nothing.
        const top = Math.max(blocks[b + 2], -row * rowStep, -row2 * row2Step);
        const bottom = Math.min(blocks[b + 3], GRID_ROWS - 1 - row * rowStep, GRID_ROWS - 1 - row2 * row2Step);
        const left = Math.max(blocks[b], -column * columnStep, -column2 * column2Step);
        const right = Math.min(
            blocks[b + 1],
            GRID_COLUMNS - 1 - column * columnStep,
            GRID_COLUMNS - 1 - column2 * column2Step,
        );
        if (top > bottom || left > right) return;
        const range = op === RefKind.Cell ? 0 : RANGE;
        const moves = rowStep | (row2Step << 1) | (columnStep << 2) | (column2Step << 3) | range;
        // A range whose columns move is an entry per host column: so the hosts of a range entry read the same rows of
        // the same columns, and one record of flagged rows holds for them all.
        const width = range !== 0 && (columnStep | column2Step) !== 0 ? 1 : right - left + 1;
        for (let first = left; first <= right; first += width) {
            const last = first + width - 1;
            areas.push(
                Math.min(row + top * rowStep, row2 + top * row2Step),
                Math.max(row + bottom * rowStep, row2 + bottom * row2Step),
                Math.min(column + first * columnStep, column2 + first * column2Step),
                Math.max(column + last * columnStep, column2 + last * column2Step),
                entries.length,
            );
            entries.push(hosts.length - 1, top, bottom, first, last, row, row2, column, column2, moves, 0, -1);
        }
    }
}
