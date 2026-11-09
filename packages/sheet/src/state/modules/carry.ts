// A carry lands a block of cells somewhere else with what belongs to them: borders, validation rules, links, merges and
// conditional formats, each keyed by the source cell it came from. A cell whose source has none of these loses its own,
// one cell at a time, as in Excel. A paste, a cut, a drag move, the format painter and a fill all land through
// carryCells, and say what of a source cell lands through its land callback.

import type { ConditionalFormatRule } from '@workspace/lib/sheets';
import { coalescedRanges, compareValidationIds, rangesOverlap } from '@workspace/lib/sheets';
import { cloneDeep, isEqual } from 'es-toolkit/compat';
import { sheetFinder } from '../../engine/a1-notation';
import type { CellResolver } from '../../engine/cell-resolver';
import { rangeWithout, withCfRanges } from '../../engine/conditional-format';
import { numberDisplay } from '../../engine/format';
import { functionCopy, moveFormulaRefs } from '../../engine/formula-shift';
import type { Cell } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import type { Sheet, SingleRange } from '../types';
import { carrySides, getBorderInfoCompute } from './border';
import { snapshotContext } from './formula-cache';
import { computeFormula } from './formula-exec';
import { addValidation, clearValidations } from './validation-rules';

const FILTERED_MERGE_REFUSAL = 'Cannot copy merged cells a filter partly hides. Clear the filter first.';
const FILTERED_MOVE_REFUSAL = 'Cannot cut or move rows a filter hides. Clear the filter first.';

// The rows and columns a copy, a move or the format painter carries, in order. Every row and column of the ranges comes
// along, hidden ones too, as in Excel, except the rows an active filter hides, which stay out so the block closes up.
// Ranges side by side share their rows, and ranges above each other share their columns. A merge can't close up, so one
// that a filter's row straddles refuses the carry, with a notice, before anything is written.
type CarriedLines = { sheetId: string; rows: readonly number[]; columns: readonly number[] };

export function carriedLines(ctx: Context, sheetId: string, ranges: readonly SingleRange[]): CarriedLines | undefined {
    const sheet = getSheet(ctx, { id: sheetId });
    // A filter entry lists the rows it hides. A row the user has shown again since is not hidden any more.
    const filtered = new Set<number>();
    const rowhidden = sheet.config?.rowhidden ?? {};
    for (const entry of Object.values(sheet.filter ?? {})) {
        for (const r of Object.keys(entry.rowhidden ?? {})) {
            if (r in rowhidden) filtered.add(Number(r));
        }
    }
    if (filtered.size > 0 && straddlesFiltered(sheet, filtered, ranges)) {
        ctx.warnDialog = FILTERED_MERGE_REFUSAL;
        return undefined;
    }
    const rows = new Set<number>();
    const columns = new Set<number>();
    for (const { row, column } of ranges) {
        for (let r = row[0]; r <= row[1]; r += 1) {
            if (!filtered.has(r)) rows.add(r);
        }
        for (let c = column[0]; c <= column[1]; c += 1) columns.add(c);
    }
    return { sheetId, rows: [...rows], columns: [...columns] };
}

// Whether a merge the ranges touch has both rows a filter hides and rows it shows. A collaborator wrote the span, so
// the walk stops at the grid.
function straddlesFiltered(sheet: Sheet, filtered: ReadonlySet<number>, ranges: readonly SingleRange[]) {
    const rowCount = sheet.data?.length ?? 0;
    return Object.values(sheet.config?.merge ?? {}).some(({ r, c, rs, cs }) => {
        const area = { row: [r, r + rs - 1], column: [c, c + cs - 1] };
        if (!ranges.some((range) => rangesOverlap(range, area))) return false;
        let hidden = 0;
        for (let row = r; row < r + rs && row < rowCount; row += 1) if (filtered.has(row)) hidden += 1;
        return hidden > 0 && hidden < rs;
    });
}

// The lines of a cut or a drag, which moves every cell of its range. A row a filter hides would land out of sight, or
// stay behind, so it refuses the move, with a notice.
export function movedLines(ctx: Context, sheetId: string, range: SingleRange): CarriedLines | undefined {
    const lines = carriedLines(ctx, sheetId, [range]);
    if (lines?.rows.length === range.row[1] - range.row[0] + 1) return lines;
    ctx.warnDialog = FILTERED_MOVE_REFUSAL;
    return undefined;
}

// One place a carried block lands: its top-left cell, and how many of its rows and columns land there. The
// format painter cuts its last tiles short at the edge of the selection, and a fill lands a tile either side of a hidden
// line, each skipping the carried lines before it.
export type CarryTile = {
    row: number;
    column: number;
    height: number;
    width: number;
    skipRows?: number;
    skipColumns?: number;
};

// One cell a carry lands: the source cell, which land copies before it changes it, and where it lands and came from.
type LandingCell = { source: Cell | null; r: number; c: number; sr: number; sc: number };

// Lands the carried block on the current sheet once per tile: every cell with its border, validation rule, link,
// merge and conditional format. land decides what of a source cell lands, so a copy can move a formula and the format
// painter can keep the destination's value. The source is read before anything is written, so a tile over the source
// reads the cells as they were. A cut then clears them.
export function carryCells(
    ctx: Context,
    lines: CarriedLines,
    tiles: readonly CarryTile[],
    land: (cell: LandingCell) => Cell | null,
    { cut = false, links = true }: { cut?: boolean; links?: boolean } = {},
) {
    const { rows, columns } = lines;
    const from = getSheet(ctx, { id: lines.sheetId });
    const to = getSheet(ctx);
    const source = from.data;
    const d = to.data;
    if (!source || !d || rows.length === 0 || columns.length === 0) return;

    // Everything is read from a plain view, because a read through an immer draft makes a child draft of each cell.
    const snapshot = snapshotContext(ctx);
    const read = getSheet(snapshot, { id: lines.sheetId });
    // A spread would overflow the stack on a whole column, so the bounds are folded.
    const lowest = (line: number, next: number) => Math.min(line, next);
    const highest = (line: number, next: number) => Math.max(line, next);
    const [top, bottom] = [rows.reduce(lowest), rows.reduce(highest)];
    const [left, right] = [columns.reduce(lowest), columns.reduce(highest)];
    const block = { row: [top, bottom], column: [left, right] };
    const borders = getBorderInfoCompute(snapshot, lines.sheetId, [top, bottom, left, right]);

    carryRules(ctx, snapshot, lines, tiles, block, cut);

    if (cut) {
        const { merge, borderInfo } = from.config ?? {};
        const { hyperlink } = from;
        for (const r of rows) {
            const row = source[r];
            for (const c of columns) {
                const mc = read.data?.[r]?.[c]?.mc;
                if (mc?.rs != null) delete merge?.[`${mc.r}_${mc.c}`];
                row[c] = null;
                const key = `${r}_${c}`;
                if (borderInfo && read.config?.borderInfo?.[key]) delete borderInfo[key];
                if (hyperlink && read.hyperlink?.[key]) delete hyperlink[key];
            }
        }
    }

    // A key the destination doesn't hold costs no write, which a sparse side table on a large carry adds up to.
    const held = getSheet(snapshot);
    const cfg = (to.config ??= {});
    const merge = (cfg.merge ??= {});
    const borderInfo = (cfg.borderInfo ??= {});
    for (const tile of tiles) {
        const { skipRows = 0, skipColumns = 0 } = tile;
        // Where each merge's first cell landed, keyed by where it was, for the merge's other cells to point at.
        const anchors: Record<string, [number, number]> = {};
        for (let i = 0; i < tile.height; i += 1) {
            const r = tile.row + i;
            const sr = rows[skipRows + i];
            const row = d[r];
            const sourceRow = read.data?.[sr];
            for (let j = 0; j < tile.width; j += 1) {
                const c = tile.column + j;
                const sc = columns[skipColumns + j];
                const sourceKey = `${sr}_${sc}`;
                const key = `${r}_${c}`;
                if (borders[sourceKey] || held.config?.borderInfo?.[key])
                    carrySides(borderInfo, r, c, borders[sourceKey]);
                // A source cell without a link takes the destination's away, as Excel does.
                const link = read.hyperlink?.[sourceKey];
                if (links && link) (to.hyperlink ??= {})[key] = link;
                else if (links && held.hyperlink?.[key]) delete to.hyperlink?.[key];

                const replaced = held.data?.[r]?.[c]?.mc && row[c];
                if (replaced?.mc) {
                    if (replaced.mc.rs != null) delete merge[`${replaced.mc.r}_${replaced.mc.c}`];
                    delete replaced.mc;
                }
                const carried = sourceRow?.[sc] ?? null;
                let cell = land({ source: carried, r, c, sr, sc });
                const sourceMc = carried?.mc;
                if (cell?.mc && sourceMc) {
                    if (cell.mc.rs != null) {
                        // A merge stops at the edge of its tile, where the format painter cuts a tile short.
                        const rs = Math.min(cell.mc.rs, tile.height - i);
                        const cs = Math.min(cell.mc.cs ?? 1, tile.width - j);
                        cell = { ...cell, mc: { r, c, rs, cs } };
                        merge[key] = { r, c, rs, cs };
                        anchors[`${sourceMc.r}_${sourceMc.c}`] = [r, c];
                    } else {
                        // A paste reads the live cells, so a merge made since the copy can start outside the block.
                        // Its cells land as plain ones.
                        const anchor = anchors[`${sourceMc.r}_${sourceMc.c}`];
                        if (anchor) cell = { mc: { r: anchor[0], c: anchor[1] } };
                        else {
                            const { mc: _, ...rest } = cell;
                            cell = rest;
                        }
                    }
                }
                row[c] = cell;
            }
        }
    }
}

// A rule leaves the cells a carry lands on and a cut's source cells, and covers the cells whose source it covered. The
// rules go in the lookup's order, so where two validations overlap a landed cell takes the one its source cell shows.
function carryRules(
    ctx: Context,
    snapshot: Context,
    lines: CarriedLines,
    tiles: readonly CarryTile[],
    block: SingleRange,
    cut: boolean,
) {
    const from = getSheet(ctx, { id: lines.sheetId });
    const to = getSheet(ctx);
    const read = getSheet(snapshot, { id: lines.sheetId });
    const held = getSheet(snapshot);
    const sameSheet = lines.sheetId === ctx.currentSheetId;
    const landing = coalescedRanges(
        tiles.map(({ row, column, height, width }) => ({
            row: [row, row + height - 1],
            column: [column, column + width - 1],
        })),
    );
    const landedOver = (ranges: readonly SingleRange[]) => {
        const near = ranges.filter((range) => rangesOverlap(range, block));
        return tiles.flatMap((tile) => near.flatMap((range) => landedRanges(range, lines, tile)));
    };

    // Worked out on a plain copy: a rule that ends as it was, after a paste inside its own cells, is not written.
    const before = held.dataValidations ?? {};
    const after = { ...before };
    const working = { ...held, dataValidations: after };
    if (cut) clearValidations(sameSheet ? working : from, block);
    for (const area of landing) clearValidations(working, area);
    const sources = Object.entries(read.dataValidations ?? {}).sort(([a], [b]) => compareValidationIds(a, b));
    for (const [id, { ranges, rule }] of sources) {
        const landed = landedOver(ranges);
        if (landed.length === 0) continue;
        // On another sheet a landed rule joins one that says the same, or is a new one.
        const twin = sameSheet ? id : Object.keys(before).find((target) => isEqual(before[target].rule, rule));
        addValidation(working, twin ?? crypto.randomUUID(), rule, landed);
    }
    for (const id of Object.keys({ ...before, ...after })) {
        if (isEqual(before[id], after[id])) continue;
        if (after[id]) (to.dataValidations ??= {})[id] = after[id];
        else delete to.dataValidations?.[id];
    }

    if (sameSheet) {
        const cleared = cut ? [block, ...landing] : landing;
        writeCfRanges(to, read.conditionalFormatRules, cleared, ({ cellrange }) => landedOver(cellrange));
        return;
    }
    const joining = new Map<ConditionalFormatRule, SingleRange[]>();
    const added: ConditionalFormatRule[] = [];
    for (const rule of read.conditionalFormatRules ?? []) {
        const landed = landedOver(rule.cellrange);
        if (landed.length === 0) continue;
        const twin = held.conditionalFormatRules?.find((target) =>
            isEqual(withCfRanges(rule, target.cellrange), target),
        );
        if (twin) joining.set(twin, [...(joining.get(twin) ?? []), ...landed]);
        else added.push(withCfRanges(rule, coalescedRanges(landed)));
    }
    if (cut) writeCfRanges(from, read.conditionalFormatRules, [block], () => []);
    writeCfRanges(to, held.conditionalFormatRules, landing, (rule) => joining.get(rule) ?? []);
    if (added.length > 0) (to.conditionalFormatRules ??= []).push(...added);
}

// Rewrites the rules of a sheet that lose the cleared areas or gain landed ranges, read from their plain view. Only a
// rule that changes is written, as its own entry, so a peer's rule beside it survives.
function writeCfRanges(
    sheet: Sheet,
    rules: readonly ConditionalFormatRule[] | undefined,
    cleared: readonly SingleRange[],
    landedOf: (rule: ConditionalFormatRule) => readonly SingleRange[],
) {
    const written = sheet.conditionalFormatRules;
    if (!rules || !written) return;
    const emptied: number[] = [];
    for (const [i, rule] of rules.entries()) {
        const landed = landedOf(rule);
        const touched = rule.cellrange.some((range) => cleared.some((area) => rangesOverlap(range, area)));
        if (!touched && landed.length === 0) continue;
        const kept = cleared.reduce<SingleRange[]>(
            (ranges, area) => ranges.flatMap((range) => rangeWithout(range, area)),
            rule.cellrange,
        );
        const next = joinedRanges(kept, landed);
        if (next.length === 0) emptied.push(i);
        // A fill or a paste inside a rule's own cells leaves the rule as it was.
        else if (!isEqual(next, rule.cellrange)) written[i] = withCfRanges(rule, next);
    }
    for (const i of emptied.reverse()) written.splice(i, 1);
}

// A rule's ranges with the landed ones joined. A formula reads relative to the first range's corner, so that corner
// stays: moved up, the formula could run off the sheet and take the whole rule with it.
function joinedRanges(ranges: readonly SingleRange[], landed: readonly SingleRange[]): SingleRange[] {
    if (ranges.length === 0) return coalescedRanges(landed);
    const [first, ...others] = ranges;
    const outside = landed.flatMap((range) => rangeWithout(range, first));
    const joined = coalescedRanges([first, ...others, ...outside]);
    const corner = joined.findIndex(({ row, column }) => row[0] === first.row[0] && column[0] === first.column[0]);
    if (corner < 0) return [first, ...coalescedRanges([...others, ...outside])];
    return [joined[corner], ...joined.toSpliced(corner, 1)];
}

// A cell where it lands. A formula's references shift by how far it travelled and it is evaluated there, on a copy,
// because the recompute that follows writes into the cell's format.
export function landedCell(
    ctx: Context,
    source: Cell | null,
    rowOffset: number,
    columnOffset: number,
    resolver: CellResolver,
): Cell | null {
    if (source?.f == null) return source;
    const func =
        rowOffset === 0 && columnOffset === 0 ? source.f : `=${functionCopy(source.f, rowOffset, columnOffset)}`;
    const [v, f] = computeFormula(ctx, func, { resolver });
    return { ...cloneDeep(source), v, f, m: numberDisplay(v, source.ct?.fa) };
}

// A cut or a drag: the block `range` lands once, its source clears, and each formula in it follows the move.
export function moveCells(ctx: Context, lines: CarriedLines, range: SingleRange, tile: CarryTile) {
    const from = getSheet(ctx, { id: lines.sheetId }).name;
    const to = getSheet(ctx).name;
    const findSheet = sheetFinder(ctx.sheets);
    const rowOffset = tile.row - range.row[0];
    const colOffset = tile.column - range.column[0];
    carryCells(
        ctx,
        lines,
        [tile],
        ({ source }) =>
            source?.f == null
                ? source
                : {
                      ...cloneDeep(source),
                      f: `=${moveFormulaRefs(source.f, range, rowOffset, colOffset, from, to, findSheet)}`,
                  },
        { cut: true },
    );
}

// Where the cells of a range land in one tile: a range for each run of carried rows and columns it covers. A block
// closed up over a filter's rows lands as one range too. Ranges copied out of the sheet's order can split one, and a
// tile the format painter cut short takes only its first rows and columns.
function landedRanges(range: SingleRange, lines: CarriedLines, tile: CarryTile): SingleRange[] {
    const { skipRows = 0, skipColumns = 0 } = tile;
    const rows = landedRuns(lines.rows.slice(skipRows, skipRows + tile.height), range.row, tile.row);
    const columns = landedRuns(lines.columns.slice(skipColumns, skipColumns + tile.width), range.column, tile.column);
    return rows.flatMap((row) => columns.map((column) => ({ row, column })));
}

// The runs of carried lines between first and last, as the lines they land on counted from start.
function landedRuns(lines: readonly number[], [first, last]: readonly number[], start: number): number[][] {
    const runs: number[][] = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] < first || lines[i] > last) continue;
        const run = runs.at(-1);
        if (run && run[1] === start + i - 1) run[1] = start + i;
        else runs.push([start + i, start + i]);
    }
    return runs;
}
