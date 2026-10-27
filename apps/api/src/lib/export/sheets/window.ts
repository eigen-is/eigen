// The part of a sheet that the HTML export or the preview renders, and the sheet clipped to it. A snapshot holds
// whatever keys a peer wrote, such as a border at row -1e12, a merge over the whole grid or a rule over a billion rows.
// windowedSheet reads each stored map once, places the window from the keys clamped to Excel's grid, and drops or clips
// every key outside it, so the renderer only ever walks the window. The export and the preview both render through it.

import { isRecord } from '@workspace/lib/guards';
import type {
    Cell,
    CellBorderSides,
    ConditionalFormatRule,
    MergeCell,
    Sheet,
    SheetConfig,
    SheetFloatingItem,
} from '@workspace/lib/sheets';
import {
    borderInfoExtent,
    floatingItems,
    parseCellKey,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
    sheetFloatingBox,
} from '@workspace/lib/sheets';
import type { Bounds, Box } from '@workspace/lib/vector';
import { getElementBounds } from '@workspace/lib/vector';
import { isWellFormedCfRule, richText, withCfRanges } from '@workspace/sheet/engine';
import { MAX_PDF_PAGE_PX } from '../weasyprint';

// A window keeps at most maxRows shown rows and maxCols shown columns from the top-left of the used range, and at most
// maxCells cells, rows times columns. maxCells is a bound of its own, so tuning the rows or the columns can never
// remove it.
export type SheetBudget = { maxRows: number; maxCols: number; maxCells: number };

type GridRange = [firstRow: number, lastRow: number, firstCol: number, lastCol: number];

// An image or chart as the overlay draws it: its box clamped as stored and moved onto the page, and the box it covers
// as it turns.
export type FloatingObject = { item: SheetFloatingItem; box: Box; bounds: Bounds };

// `rows` and `cols` are the shown tracks the window renders, in order. `range` is the rectangle they span, the hidden
// tracks inside it included, and null for a sheet with nothing but images or charts. `offset` is the pixels from A1 to
// the window's first cell, which the overlay subtracts from each stored box. `floating` is the sheet's images and
// charts in paint order. `cells` is what the window costs.
export type WindowedSheet = {
    sheet: Sheet;
    rows: number[];
    cols: number[];
    range: GridRange | null;
    offset: { left: number; top: number };
    floating: FloatingObject[];
    truncated: boolean;
    cells: number;
};

// A track longer than the largest PDF page is no length a sheet has: Excel's widest column is under 2,000 px.
const MAX_TRACK_PX = MAX_PDF_PAGE_PX;

// The editor and the import write whole pixels, so a track shorter than one is no length a sheet has either. The editor
// draws a stored 0 at the default, and a length like 1e-300 would take the window to a track no count reaches.
const MIN_TRACK_PX = 1;

// How many keys each track map holds, counted once per map: enumerating a million of them costs about 250 ms.
const keyCounts = new WeakMap<object, number>();

// The sheet cut to the window that `budgetFor` sizes from its shown rows and columns, or null when the budget holds
// none of its rows. Keys past Excel's grid, merges that overlap an earlier one and track sizes no sheet can have are
// dropped first, so every walk after this is bounded by the window.
export function windowedSheet(
    sheet: Sheet,
    budgetFor: (shownRows: number, shownCols: number) => SheetBudget,
): WindowedSheet | null {
    const config = sheet.config ?? {};
    const defaultRowHeight = trackLength(sheet.defaultRowHeight) ?? SHEET_DEFAULT_ROW_HEIGHT;
    const defaultColWidth = trackLength(sheet.defaultColWidth) ?? SHEET_DEFAULT_COL_WIDTH;
    const tracksOf = (rows: [number, number], cols: [number, number]): Sheet => ({
        ...sheet,
        defaultRowHeight,
        defaultColWidth,
        config: {
            ...config,
            rowlen: lengthsIn(config.rowlen, ...rows),
            columnlen: lengthsIn(config.columnlen, ...cols),
            rowhidden: hiddenIn(config.rowhidden, ...rows),
            colhidden: hiddenIn(config.colhidden, ...cols),
        },
    });
    const merges = gridMerges(config.merge);
    const bounds = usedBounds(sheet, merges);
    const floating = floatingObjects(sheet);
    const empty = budgetFor(0, 0);
    if (!bounds) {
        const { maxRows, maxCols } = empty;
        const blank = tracksOf([0, maxRows - 1], [0, maxCols - 1]);
        return {
            sheet: blank,
            rows: [],
            cols: [],
            range: null,
            offset: { left: 0, top: 0 },
            floating,
            truncated: false,
            cells: 0,
        };
    }
    // A sheet with content costs at least one cell, so a budget with none left leaves it out before any map is read.
    if (empty.maxCells < 1) return null;

    // The overlay places images and charts at their stored pixels from A1. One above or left of the used range would
    // take a negative offset and fall off the page, so the window starts at the track the earliest one starts in.
    let x = Number.POSITIVE_INFINITY;
    let y = Number.POSITIVE_INFINITY;
    for (const { bounds: turned } of floating) {
        x = Math.min(x, turned.minX);
        y = Math.min(y, turned.minY);
    }
    const left = trackAt(x, bounds.minCol, config.colhidden, config.columnlen, defaultColWidth);
    const top = trackAt(y, bounds.minRow, config.rowhidden, config.rowlen, defaultRowHeight);
    const [firstRow, firstCol] = [top.index, left.index];

    const shownRows = bounds.maxRow - firstRow + 1 - tracksIn(config.rowhidden, firstRow, bounds.maxRow).length;
    const shownCols = bounds.maxCol - firstCol + 1 - tracksIn(config.colhidden, firstCol, bounds.maxCol).length;
    const budget = budgetFor(shownRows, shownCols);
    const keptCols = Math.min(shownCols, budget.maxCols);
    // A row whose every column is hidden still costs one cell, and a sheet whose every row is hidden costs one row.
    const rowCells = Math.max(1, keptCols);
    if (rowCells > budget.maxCells) return null;
    const keptRows = Math.min(shownRows, budget.maxRows, Math.floor(budget.maxCells / rowCells));

    const rows = shownTracks(firstRow, bounds.maxRow, keptRows, config.rowhidden);
    const cols = shownTracks(firstCol, bounds.maxCol, keptCols, config.colhidden);
    const range: GridRange = [
        firstRow,
        keptRows < shownRows ? (rows.at(-1) ?? firstRow) : bounds.maxRow,
        firstCol,
        keptCols < shownCols ? (cols.at(-1) ?? firstCol) : bounds.maxCol,
    ];
    // The track sizes reach a budget's worth of tracks past a small sheet, as far as the preview's overlay box.
    const tracks = tracksOf(
        [firstRow, Math.min(REFERENCE_ROW_COUNT - 1, Math.max(range[1], firstRow + budget.maxRows - 1))],
        [firstCol, Math.min(REFERENCE_COLUMN_COUNT - 1, Math.max(range[3], firstCol + budget.maxCols - 1))],
    );
    const windowed: Sheet = {
        ...tracks,
        celldata: sheet.celldata?.filter(({ r, c }) => inRange(range, r, c)),
        config: {
            ...tracks.config,
            borderInfo: windowBorders(config.borderInfo, range),
            merge: windowMerges(merges, range),
        },
        conditionalFormatRules: sheet.conditionalFormatRules && clipRulesToWindow(sheet.conditionalFormatRules, range),
    };
    return {
        sheet: windowed,
        rows,
        cols,
        range,
        offset: { left: left.start, top: top.start },
        floating,
        truncated: keptRows < shownRows || keptCols < shownCols,
        cells: Math.max(1, keptRows) * rowCells,
    };
}

// Every image and chart in their one paint order. sheetFloatingBox clamps each box as the editor's writers store it,
// and turns a string a peer stored into its number. The box it covers as it turns sizes the page, places the window's
// origin and meets the preview's clip. One turned past A1 tucks under the editor's headers, but a page has none, so
// it moves right or down until it starts on the page.
function floatingObjects(sheet: Sheet): FloatingObject[] {
    return floatingItems(sheet).map((item) => {
        const stored = sheetFloatingBox(item.object);
        const turned = getElementBounds(stored);
        const box = { ...stored, x: stored.x - Math.min(0, turned.minX), y: stored.y - Math.min(0, turned.minY) };
        return { item, box, bounds: getElementBounds(box) };
    });
}

// A stored length, as a number, when a sheet can have it. Geometry is schemaless at the Yjs boundary, so a peer can
// store a string, a negative or a length no page holds.
function trackLength(value: unknown): number | undefined {
    const length = Number(value ?? Number.NaN);
    return length >= MIN_TRACK_PX && length <= MAX_TRACK_PX ? length : undefined;
}

// The tracks from first to last that a map has a key for, ascending. A span shorter than the map's keys is walked by
// lookup, so a map of a million hidden rows can't slow down a small window. Any other span reads the map's keys, so a
// first cell at the far end of the grid costs what the map holds, not the tracks before it.
function tracksIn(map: Record<string, number> | undefined, first: number, last: number): number[] {
    const tracks: number[] = [];
    // A WeakMap refuses a key that is no object, and a peer can store a number or a string as the map.
    if (!isRecord(map)) return tracks;
    let keys = keyCounts.get(map);
    if (keys === undefined) {
        keys = Object.keys(map).length;
        keyCounts.set(map, keys);
    }
    if (last - first < keys) {
        for (let track = first; track <= last; track++) if (map[track] != null) tracks.push(track);
        return tracks;
    }
    // Only a key a lookup by index finds counts: `1`, not `01` or `1.0`. Index keys enumerate in ascending order.
    for (const key in map) {
        const track = Number(key);
        if (Number.isInteger(track) && track >= first && track <= last && String(track) === key && map[key] != null) {
            tracks.push(track);
        }
    }
    return tracks;
}

// The lengths a sheet can have, for the tracks from first to last. The others read as the sheet's default.
function lengthsIn(lengths: Record<string, number> | undefined, first: number, last: number): Record<string, number> {
    const kept: Record<string, number> = {};
    for (const track of tracksIn(lengths, first, last)) {
        const length = trackLength(lengths?.[track]);
        if (length !== undefined) kept[track] = length;
    }
    return kept;
}

// The hidden tracks from first to last. A track is hidden by its key, whatever it holds but null: the editor stores 0.
function hiddenIn(hidden: Record<string, number> | undefined, first: number, last: number): Record<string, number> {
    const kept: Record<string, number> = {};
    for (const track of tracksIn(hidden, first, last)) kept[track] = 0;
    return kept;
}

// Each stored merge as whole numbers, cut to Excel's grid. One that names no cell of it is dropped, and so is a null.
function gridMerges(merge: SheetConfig['merge']): MergeCell[] {
    const merges: MergeCell[] = [];
    for (const m of Object.values(merge ?? {})) {
        if (!m) continue;
        const [r, c, rs, cs] = [Number(m.r), Number(m.c), Number(m.rs), Number(m.cs)];
        if (![r, c, rs, cs].every(Number.isInteger)) continue;
        const r0 = Math.max(r, 0);
        const c0 = Math.max(c, 0);
        const r1 = Math.min(r + rs - 1, REFERENCE_ROW_COUNT - 1);
        const c1 = Math.min(c + cs - 1, REFERENCE_COLUMN_COUNT - 1);
        if (r0 <= r1 && c0 <= c1) merges.push({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    }
    return merges;
}

// The box of the cells with content, the border keys and the merges, clamped to Excel's grid on both sides, or null
// when none of them lies in it.
function usedBounds(
    sheet: Sheet,
    merges: MergeCell[],
): { minRow: number; minCol: number; maxRow: number; maxCol: number } | null {
    // The raw border keys: folding onto a merge's first cell only ever drops keys.
    let { minRow, minCol, maxRow, maxCol } = borderInfoExtent(sheet.config?.borderInfo ?? {});
    const extend = (r: number, c: number, endRow: number, endCol: number) => {
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
        if (endRow > maxRow) maxRow = endRow;
        if (endCol > maxCol) maxCol = endCol;
    };
    for (const { r, c, v } of sheet.celldata ?? []) {
        if (hasVisibleContent(v)) extend(r, c, r, c);
    }
    for (const m of merges) extend(m.r, m.c, m.r + m.rs - 1, m.c + m.cs - 1);
    minRow = Math.max(0, Math.ceil(minRow));
    minCol = Math.max(0, Math.ceil(minCol));
    maxRow = Math.min(REFERENCE_ROW_COUNT - 1, Math.floor(maxRow));
    maxCol = Math.min(REFERENCE_COLUMN_COUNT - 1, Math.floor(maxCol));
    return minRow <= maxRow && minCol <= maxCol ? { minRow, minCol, maxRow, maxCol } : null;
}

// Whether a cell shows anything: a value, a color, a font look, or the first cell of a merge, which holds its size in
// `mc`. A peer can store any value there, and `in` throws on one that is no object.
function hasVisibleContent(v: Cell | null): boolean {
    if (!v) return false;
    if (v.v != null || v.m != null || richText(v) !== undefined) return true;
    if (v.bg || v.fc) return true;
    if (v.bl === 1 || v.it === 1 || v.un === 1 || v.cl === 1) return true;
    return isRecord(v.mc) && 'rs' in v.mc;
}

// The track that `px` falls in, at most `limit`, and the pixels before it. The tracks no map names are all `fallback`
// long, so the answer comes from the maps and a division, never from a walk over the tracks before it.
function trackAt(
    px: number,
    limit: number,
    hidden: Record<string, number> | undefined,
    lengths: Record<string, number> | undefined,
    fallback: number,
): { index: number; start: number } {
    const named = new Map<number, number>();
    for (const track of tracksIn(lengths, 0, limit - 1)) named.set(track, trackLength(lengths?.[track]) ?? fallback);
    for (const track of tracksIn(hidden, 0, limit - 1)) named.set(track, 0);
    let index = 0;
    let start = 0;
    // A track is passed while the pixel lies at or past its end. A box turned past A1 can start a few ulps before 0.
    const passDefaults = (count: number) => {
        const passed = Math.min(count, Math.floor(Math.max(0, px - start) / fallback));
        index += passed;
        start += passed * fallback;
        return passed === count;
    };
    for (const track of [...named.keys()].sort((a, b) => a - b)) {
        if (!passDefaults(track - index)) return { index, start };
        const length = named.get(track) ?? fallback;
        if (start + length > px) return { index, start };
        index = track + 1;
        start += length;
    }
    passDefaults(limit - index);
    return { index, start };
}

// The first `count` shown tracks from `first`, which costs those and the hidden ones between them. A string stored as
// the map would hide a track by each of its characters.
function shownTracks(first: number, last: number, count: number, hidden: Record<string, number> | undefined): number[] {
    const tracks: number[] = [];
    for (let track = first; track <= last && tracks.length < count; track++) {
        if (!isRecord(hidden) || hidden[track] == null) tracks.push(track);
    }
    return tracks;
}

function inRange([firstRow, lastRow, firstCol, lastCol]: GridRange, r: number, c: number): boolean {
    return r >= firstRow && r <= lastRow && c >= firstCol && c <= lastCol;
}

// The border keys inside the window, each the `r_c` a lookup by cell finds.
function windowBorders(
    borderInfo: Record<string, CellBorderSides> | undefined,
    range: GridRange,
): Record<string, CellBorderSides> {
    const kept: Record<string, CellBorderSides> = {};
    for (const key in borderInfo) {
        const [r, c] = parseCellKey(key);
        if (inRange(range, r, c) && key === `${r}_${c}`) kept[key] = borderInfo[key];
    }
    return kept;
}

// Each merge cut to the window, without the ones that overlap an earlier one in reading order, as Excel forbids
// overlapping merges. The sweep keeps, for each column, the last row a kept merge covers, so a merge overlaps a kept
// one exactly when one of its columns is covered at its first row. A merge as wide as the grid would make a scan of
// its columns cost the window's width for each merge, so a segment tree answers for the whole span in log time.
function windowMerges(merges: MergeCell[], range: GridRange): Record<string, MergeCell> {
    const [firstRow, lastRow, firstCol, lastCol] = range;
    const clipped: MergeCell[] = [];
    for (const m of merges) {
        const r0 = Math.max(m.r, firstRow);
        const c0 = Math.max(m.c, firstCol);
        const r1 = Math.min(m.r + m.rs - 1, lastRow);
        const c1 = Math.min(m.c + m.cs - 1, lastCol);
        if (r0 <= r1 && c0 <= c1) clipped.push({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    }
    clipped.sort((a, b) => a.r - b.r || a.c - b.c);
    // A node holds the last row covered anywhere in its span, and the last row a kept merge covers all of its span to.
    // A merge is kept only when its columns are covered above its first row, so its last row is past each of theirs.
    const width = lastCol - firstCol + 1;
    const below = new Int32Array(4 * width).fill(-1);
    const whole = new Int32Array(4 * width).fill(-1);
    const coveredTo = (node: number, lo: number, hi: number, from: number, to: number): number => {
        if (to < lo || hi < from) return -1;
        if (from <= lo && hi <= to) return below[node];
        const mid = (lo + hi) >> 1;
        const left = coveredTo(2 * node, lo, mid, from, to);
        return Math.max(whole[node], left, coveredTo(2 * node + 1, mid + 1, hi, from, to));
    };
    const cover = (node: number, lo: number, hi: number, from: number, to: number, row: number) => {
        if (to < lo || hi < from) return;
        below[node] = Math.max(below[node], row);
        if (from <= lo && hi <= to) {
            whole[node] = row;
            return;
        }
        const mid = (lo + hi) >> 1;
        cover(2 * node, lo, mid, from, to, row);
        cover(2 * node + 1, mid + 1, hi, from, to, row);
    };
    const kept: Record<string, MergeCell> = {};
    for (const m of clipped) {
        const [from, to] = [m.c - firstCol, m.c - firstCol + m.cs - 1];
        if (coveredTo(1, 0, width - 1, from, to) >= m.r) continue;
        cover(1, 0, width - 1, from, to, m.r + m.rs - 1);
        kept[`${m.r}_${m.c}`] = m;
    }
    return kept;
}

// A rule may name the whole sheet while the window is small, and the evaluator visits every cell of every range,
// running a formula rule's engine once per cell. Clipping keeps that work to the window's rows and columns, its hidden
// ones included. A rule that misses the window drops out, and a formula rule keeps its anchor (withCfRanges). So does
// a rule whose shape the evaluator can't read, as a peer can store anything.
function clipRulesToWindow(
    rules: ConditionalFormatRule[],
    [firstRow, lastRow, firstCol, lastCol]: GridRange,
): ConditionalFormatRule[] {
    const clipped: ConditionalFormatRule[] = [];
    for (const rule of rules) {
        if (!isWellFormedCfRule(rule)) continue;
        const cellrange = rule.cellrange
            .map((range) => ({
                row: [Math.max(range.row[0], firstRow), Math.min(range.row[1], lastRow)],
                column: [Math.max(range.column[0], firstCol), Math.min(range.column[1], lastCol)],
            }))
            .filter((range) => range.row[0] <= range.row[1] && range.column[0] <= range.column[1]);
        if (cellrange.length > 0) clipped.push(withCfRanges(rule, cellrange));
    }
    return clipped;
}
