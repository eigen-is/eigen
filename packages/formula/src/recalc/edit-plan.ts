// What a structural edit does to the formulas of a workbook, worked out before a cell moves: per block of cells of
// one shape, the classes of hosts the transform gives one outcome. A class whose text changes gets its new shape,
// a class undo cannot derive back is reported with the text it loses, and a class whose value can change is a seed
// of the recompute. Everything is in the places before the edit, but the blocks reported to the host.

import { sheetOf } from '../edit/leaves';
import { moveClasses } from '../edit/move';
import { bindSheet } from '../edit/sheets';
import { hostClasses } from '../edit/transform';
import { Fact } from '../eval/facts';
import type { Sheet } from '../store/sheet';
import type { Change, Workbook } from '../store/workbook';
import { ChangeKind } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { Ends, FormulaNode } from '../text/tree';
import { endsAt, RefKind, SheetKind } from '../text/tree';

// One block of cells that hold one formula after an edit, where they are after it: a formula the edit rewrote, or
// one it left as it was while undo cannot derive the old text back.
export type Rewrite = {
    readonly sheet: string;
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
    // The stored text the cells hold now.
    readonly formula: string;
    // The stored text they held, when the inverse edit does not bring it back. Else null.
    readonly lost: string | null;
};

export type EditPlan = {
    // The blocks that get another shape: sheet, first and last column, first and last row, and shape.
    readonly fills: number[];
    // The formulas to compute again, as spans of rows: sheet, column, first and last row.
    readonly seeds: number[];
    readonly rewrites: Rewrite[];
};

// `rectangles` are the blocks of one shape the reverse index found, and `facts` the facts of every shape by id.
export function planEdit(
    workbook: Workbook,
    rectangles: readonly number[],
    facts: readonly number[],
    change: Change,
): EditPlan {
    const { sheets, shapes } = workbook;
    const plan: EditPlan = { fills: [], seeds: [], rewrites: [] };
    for (let r = 0; r < rectangles.length; r += 6) {
        const place = rectangles[r];
        const left = rectangles[r + 1];
        const right = rectangles[r + 2];
        const top = rectangles[r + 3];
        const bottom = rectangles[r + 4];
        const id = rectangles[r + 5];
        const shape = shapes.shape(id);
        const { tree, refs } = shape;
        // Text that did not parse is kept as it is.
        if (tree === null) continue;
        const host = sheets[place];
        const positional = (facts[id] & Fact.Positional) !== 0;
        // One class of hosts, in the places before the edit, then the sheet and the distance it goes to.
        const outcome = (
            next: FormulaNode,
            lossy: boolean,
            seed: boolean,
            block: readonly [top: number, left: number, bottom: number, right: number],
            sheet: string,
            down: number,
            across: number,
        ) => {
            const changed = next !== tree;
            const shaped = changed ? shapes.internTree(next) : id;
            if (changed) plan.fills.push(place, block[1], block[3], block[0], block[2], shaped);
            if (changed || lossy) {
                plan.rewrites.push({
                    sheet,
                    top: block[0] + down,
                    left: block[1] + across,
                    bottom: block[2] + down,
                    right: block[3] + across,
                    formula: shapes.shape(shaped).text,
                    lost: lossy ? shape.text : null,
                });
            }
            if (seed || (positional && (changed || down !== 0 || across !== 0 || sheet !== host.id))) {
                for (let c = block[1]; c <= block[3]; c += 1) plan.seeds.push(place, c, block[0], block[2]);
            }
        };
        switch (change.kind) {
            case ChangeKind.Lines: {
                const { edit } = change;
                const { rows, index, insert, count } = edit;
                const sized = (facts[id] & Fact.Sized) !== 0;
                const edited = workbook.known(edit.sheet);
                const distance = insert ? count : -count;
                // The first line whose cells an insert pushes off the grid.
                const lost = Math.max(index, (rows ? GRID_ROWS : GRID_COLUMNS) - count);
                const first = rows ? left : top;
                const last = rows ? right : top;
                for (const found of hostClasses(tree, refs, edit, host.id, rows ? top : left, rows ? bottom : right)) {
                    const { start, end } = found;
                    const shift = host === edited && start >= index ? distance : 0;
                    // The cells an insert moves keep their order and lose none, so a formula that only passes
                    // over the empty ones answers as before: unless the insert pushed a cell off the grid.
                    const slides =
                        found.slid &&
                        holds(edited, refs, host.id, rows, index, first, last) &&
                        (!insert || sized || holds(edited, refs, host.id, rows, lost, first, last));
                    const seed = found.recompute || (found.resized && sized) || slides;
                    if (rows) outcome(found.tree, found.lossy, seed, [start, left, end, right], host.id, shift, 0);
                    else outcome(found.tree, found.lossy, seed, [top, start, bottom, end], host.id, 0, shift);
                }
                break;
            }
            case ChangeKind.Move: {
                const { move } = change;
                for (const found of moveClasses(tree, refs, move, host.id, top, bottom, left, right)) {
                    const { carried } = found;
                    outcome(
                        found.tree,
                        found.lossy,
                        found.recompute,
                        [found.top, found.left, found.bottom, found.right],
                        carried ? move.toSheet : host.id,
                        carried ? move.toRow - move.row : 0,
                        carried ? move.toColumn - move.column : 0,
                    );
                }
                break;
            }
            default: {
                // A formula typed with the name of a sheet that was not there reads the sheet that now has the
                // name. One that names the sheet that comes or goes by its id reads other cells than it did, and
                // so does one that reads a span of sheets, whichever sheet comes, goes or moves.
                let bound = tree;
                let named = '';
                if (change.kind === ChangeKind.AddSheet) {
                    named = change.source.id;
                    if (shape.namesSheet) bound = bindSheet(tree, change.source.name, named);
                } else if (change.kind === ChangeKind.RenameSheet) {
                    if (shape.namesSheet) bound = bindSheet(tree, change.name, change.sheet);
                } else if (change.kind === ChangeKind.RemoveSheet) named = change.sheet;
                const reads = refs.some(
                    (ref) =>
                        ref.sheetKind === SheetKind.Span || (ref.sheetKind === SheetKind.Id && ref.sheet === named),
                );
                outcome(bound, bound !== tree, reads || bound !== tree, [top, left, bottom, right], host.id, 0, 0);
            }
        }
    }
    return plan;
}

// Whether a whole column or row that a formula names on the edited sheet holds a cell at or past `line`, a row
// when `rows` and else a column, for some host of a block: the hosts on the columns `first` to `last` when rows
// are edited, the hosts from the row `first` down when columns are. From the line of an edit on, those are the
// cells it reads that change place.
function holds(
    edited: Sheet,
    refs: readonly FormulaNode[],
    hostSheet: string,
    rows: boolean,
    line: number,
    first: number,
    last: number,
): boolean {
    const { columns } = edited;
    const ends: Ends = { first: 0, second: 0 };
    for (const ref of refs) {
        if (ref.op !== (rows ? RefKind.Columns : RefKind.Rows) || sheetOf(ref, hostSheet) !== edited.id) continue;
        // The lines it names across the edit: an end that moves with the host is lowest at the first host.
        endsAt(ref, !rows, first, 0, ends);
        const low = Math.max(0, Math.min(ends.first, ends.second));
        endsAt(ref, !rows, last, 0, ends);
        const high = Math.max(ends.first, ends.second);
        const from = rows ? low : line;
        const to = Math.min(rows ? high : columns.length - 1, columns.length - 1);
        for (let c = from; c <= to; c += 1) {
            if (columns[c].length > (rows ? line : low)) return true;
        }
    }
    return false;
}
