// A carry lands a block of cells somewhere else with what belongs to them: borders, validation rules, merges and
// conditional formats, each keyed by the source cell it came from, and each changed rule written under its id. A cell
// whose source has none of these loses its own, one cell at a time, as in Excel. Paths such as a paste, a cut, a fill
// and the format painter land through carryCells, and each one's callback says what of a source cell lands, its value
// and link included.

import type { ConditionalFormatRule } from '@workspace/lib/sheets';
import {
    coalescedRanges,
    MAX_CONDITIONAL_FORMATS,
    MAX_RULE_RANGES,
    nextRuleOrder,
    orderedRules,
    rangesOverlap,
} from '@workspace/lib/sheets';
import { cloneDeep, isEqual } from 'es-toolkit/compat';
import { sheetFinder } from '../../engine/a1-notation';
import { rangeWithout, withCfRanges } from '../../engine/conditional-format';
import { moveFormulaRefs } from '../../engine/formula-shift';
import type { Cell } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import type { Sheet, SingleRange } from '../types';
import { carrySides, getBorderInfoCompute } from './border';
import { snapshotContext } from './formula-cache';
import { addValidation, clearValidations } from './validation-rules';

const FILTERED_MERGE_REFUSAL = 'Cannot copy merged cells a filter partly hides. Clear the filter first.';
const FILTERED_MOVE_REFUSAL = 'Cannot cut or move rows a filter hides. Clear the filter first.';

type CarriedLines = { sheetId: string; rows: readonly number[]; columns: readonly number[] };

// The rows and columns a carry takes, in order: hidden ones too, as in Excel, except the rows an active filter hides,
// so the block closes up. A merge can't close up, so one a filter's row straddles refuses the carry before any write.
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

// One place a carried block lands: its top-left cell, and how many of its rows and columns land there. A tile can
// start past some carried lines, as a fill's does on either side of a hidden line.
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

// Lands the carried block on the current sheet once per tile, each cell with its side tables. The source is read
// before anything is written, so a tile over the source reads the cells as they were, and a cut then clears them.
export function carryCells(
    ctx: Context,
    lines: CarriedLines,
    tiles: readonly CarryTile[],
    land: (cell: LandingCell) => Cell | null,
    cut = false,
) {
    const { rows, columns } = lines;
    const from = getSheet(ctx, { id: lines.sheetId });
    const to = getSheet(ctx);
    const source = from.data;
    const data = to.data;
    if (!source || !data || rows.length === 0 || columns.length === 0) return;

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
        for (const r of rows) {
            const row = source[r];
            for (const c of columns) {
                const mc = read.data?.[r]?.[c]?.mc;
                if (mc?.rs != null) delete merge?.[`${mc.r}_${mc.c}`];
                row[c] = null;
                const key = `${r}_${c}`;
                if (borderInfo && read.config?.borderInfo?.[key]) delete borderInfo[key];
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
            const row = data[r];
            const sourceRow = read.data?.[sr];
            for (let j = 0; j < tile.width; j += 1) {
                const c = tile.column + j;
                const sc = columns[skipColumns + j];
                const sourceKey = `${sr}_${sc}`;
                const key = `${r}_${c}`;
                if (borders[sourceKey] || held.config?.borderInfo?.[key])
                    carrySides(borderInfo, r, c, borders[sourceKey]);

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

// A rule leaves the cells a carry lands on and a cut's source cells, and covers the cells whose source it covered.
// The landed cells join the source rule, or on another sheet a rule that says the same, else a new rule that goes last.
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
    const working = { ...held, dataValidations: { ...before } };
    if (cut) clearValidations(sameSheet ? working : from, block);
    for (const area of landing) clearValidations(working, area);
    for (const [id, { ranges, rule }] of orderedRules(read.dataValidations)) {
        const landed = landedOver(ranges);
        if (landed.length === 0) continue;
        const twin = sameSheet ? id : Object.keys(before).find((target) => isEqual(before[target].rule, rule));
        addValidation(working, twin ?? crypto.randomUUID(), rule, landed);
    }
    writeChanged((to.dataValidations ??= {}), before, working.dataValidations);

    const formats = held.conditionalFormats ?? {};
    const landedOn = new Map<string, SingleRange[]>();
    const added: ConditionalFormatRule[] = [];
    for (const [id, rule] of orderedRules(read.conditionalFormats)) {
        const landed = landedOver(rule.ranges);
        if (landed.length === 0) continue;
        // On another sheet a rule joins one that would say the same over its ranges, whatever its place in the order.
        const onto = ({ ranges, order }: ConditionalFormatRule) => ({ ...withCfRanges(rule, ranges), order });
        const twin = sameSheet ? id : Object.keys(formats).find((key) => isEqual(onto(formats[key]), formats[key]));
        if (twin === undefined) added.push(withCfRanges(rule, coalescedRanges(landed)));
        else landedOn.set(twin, [...(landedOn.get(twin) ?? []), ...landed]);
    }
    const next = carriedFormats(formats, cut && sameSheet ? [block, ...landing] : landing, landedOn);
    for (const rule of added) {
        if (Object.keys(next).length >= MAX_CONDITIONAL_FORMATS) break;
        next[crypto.randomUUID()] = { ...rule, order: nextRuleOrder(next) };
    }
    writeChanged((to.conditionalFormats ??= {}), formats, next);
    if (cut && !sameSheet) {
        const source = read.conditionalFormats ?? {};
        writeChanged((from.conditionalFormats ??= {}), source, carriedFormats(source, [block], new Map()));
    }
}

// A sheet's conditional formats without the cleared areas and with the ranges landed on each rule; a rule left with
// no cell goes, and one that would pass the range cap stays as it was.
function carriedFormats(
    rules: Readonly<Record<string, ConditionalFormatRule>>,
    cleared: readonly SingleRange[],
    landedOn: ReadonlyMap<string, readonly SingleRange[]>,
): Record<string, ConditionalFormatRule> {
    const next = { ...rules };
    for (const [id, rule] of Object.entries(rules)) {
        const landed = landedOn.get(id) ?? [];
        const touched = rule.ranges.some((range) => cleared.some((area) => rangesOverlap(range, area)));
        if (!touched && landed.length === 0) continue;
        const kept = cleared.reduce<SingleRange[]>(
            (ranges, area) => ranges.flatMap((range) => rangeWithout(range, area)),
            rule.ranges,
        );
        const ranges = joinedRanges(kept, landed);
        if (ranges.length === 0) delete next[id];
        else if (ranges.length <= MAX_RULE_RANGES) next[id] = withCfRanges(rule, ranges);
    }
    return next;
}

// Writes the rules that differ from the plain view they were read from, each under its id, so a peer's rule beside
// them survives, and a fill or a paste inside a rule's own cells writes nothing.
function writeChanged<R>(
    written: Record<string, R>,
    before: Readonly<Record<string, R>>,
    after: Readonly<Record<string, R>>,
) {
    for (const id of Object.keys({ ...before, ...after })) {
        if (isEqual(before[id], after[id])) continue;
        if (after[id]) written[id] = after[id];
        else delete written[id];
    }
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
        true,
    );
}

// Where the cells of a range land in one tile: a range for each run of carried rows and columns it covers, so a
// block closed up over a filter's rows lands as one range.
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
