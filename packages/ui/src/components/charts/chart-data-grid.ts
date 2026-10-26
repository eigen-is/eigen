// Edit data's grid as plain data, with no React: a chart's inline data as rows of typed text, the selection on it, and
// the edits the dialog makes, such as a paste or a cleared range. A cell keeps the text it was given, so a value that
// isn't a number stays on screen, flagged. The dialog renders the grid and writes the spec it turns back into.

import {
    chartLabel,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    inlineRowCount,
    newChartSeriesId,
} from '@workspace/lib/charts';
import type { ChartSpec, InlineChartData } from '@workspace/lib/types/chart';
import { fromPercent } from './percent';

export type InlineChartSpec = ChartSpec & { data: InlineChartData };

export type GridColumn = { id: string; name: string };
// A row carries the index it opened at, so a removed row takes its points, such as its pie slice's color, with it and
// the rows after it keep theirs. A new row has none, so its points are automatic.
export type GridRow = { origin: number | null; category: string; cells: string[] };
// The corner, A1, heads the categories column: the category axis title, as in Google.
export type Grid = { corner: string; columns: GridColumn[]; rows: GridRow[] };

// Grid coordinates: row 0 is the series names (the sheet's row 1), column 0 the categories (column A), so
// (0, 0) is the corner.
export type CellRef = { row: number; column: number };
// A header click selects whole rows or columns, which Delete removes rather than clears.
export type GridSelection = { anchor: CellRef; focus: CellRef; whole?: 'rows' | 'columns' };

export function gridOf({ data, axes }: InlineChartSpec): Grid {
    const count = inlineRowCount(data);
    return {
        corner: axes.x.title.text,
        columns: data.series.map(({ id, name }) => ({ id, name })),
        rows: Array.from({ length: count }, (_, i) => ({
            origin: i,
            category: data.categories[i] ?? '',
            cells: data.series.map((series) => String(series.values[i] ?? '')),
        })),
    };
}

// The spec a grid writes: its data and the category axis title in A1. A series' style isn't the grid's.
export function specOf({ corner, columns, rows }: Grid, spec: InlineChartSpec): ChartSpec {
    return {
        ...spec,
        axes: { ...spec.axes, x: { ...spec.axes.x, title: { text: corner } } },
        data: {
            source: 'inline',
            categories: rows.map((row) => row.category),
            series: columns.map(({ id, name }, j) => ({ id, name, values: rows.map((row) => numberOf(row.cells[j])) })),
        },
    };
}

// A number as Sheets shows one in the en convention: grouped (1,234), after a currency symbol ($1,234.00,
// -€5) or a percent (12% is 0.12). An empty cell is a gap; anything else is NaN, and flagged. The digits before and
// after the point are split by the point itself, so a long run of digits that isn't a number fails in linear time: a
// pasted cell is checked on every render.
const NUMBER_TEXT = /^([-+]?)[$€£¥]?(\d{1,3}(?:,\d{3})+(?:\.\d*)?|(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?)(%?)$/i;
export function numberOf(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const match = NUMBER_TEXT.exec(trimmed);
    if (!match) return Number.NaN;
    const [, sign, digits, percent] = match;
    const value = Number(`${sign}${digits.replaceAll(',', '')}`);
    return percent ? fromPercent(value) : value;
}
export const isNumberText = (text: string) => {
    const value = numberOf(text);
    return value === null || Number.isFinite(value);
};

export function cellText(grid: Grid, { row, column }: CellRef): string {
    if (row === 0) return column === 0 ? grid.corner : (grid.columns[column - 1]?.name ?? '');
    const source = grid.rows[row - 1];
    if (!source) return '';
    return column === 0 ? source.category : (source.cells[column - 1] ?? '');
}

// The grid as shown, the header row and category column included: every column a series can go in, and
// rows to the ones the view reaches or one past the data, up to the category limit.
export function shownSize({ rows }: Grid, reach: number) {
    return {
        rows: Math.min(INLINE_GRID_MAX_CATEGORIES + 1, Math.max(rows.length + 2, reach)),
        columns: INLINE_GRID_MAX_SERIES + 1,
    };
}

export function rangeOf({ anchor, focus }: GridSelection) {
    return {
        top: Math.min(anchor.row, focus.row),
        bottom: Math.max(anchor.row, focus.row),
        left: Math.min(anchor.column, focus.column),
        right: Math.max(anchor.column, focus.column),
    };
}
export type Range = ReturnType<typeof rangeOf>;

// A block of text fills the grid from (row, column), growing it as far as the limits allow; `clipped` says
// some didn't fit. A paste and a committed cell both land through here.
export function fill(grid: Grid, row: number, column: number, block: string[][]): { grid: Grid; clipped: boolean } {
    const width = widthOf(block);
    let series = Math.max(grid.columns.length, Math.min(INLINE_GRID_MAX_SERIES, column + width - 1));
    let rows = Math.max(grid.rows.length, Math.min(INLINE_GRID_MAX_CATEGORIES, row + block.length - 1));
    // The points limit holds the growth back, new series first.
    while (!fitsInlineGrid(series, rows) && series > grid.columns.length) series -= 1;
    while (!fitsInlineGrid(series, rows) && rows > grid.rows.length) rows -= 1;

    const columns = Array.from({ length: series }, (_, j) => ({ ...(grid.columns[j] ?? newColumn()) }));
    const next = Array.from({ length: rows }, (_, i) => {
        const source = grid.rows[i] ?? newRow(series);
        return { ...source, cells: Array.from({ length: series }, (_, j) => source.cells[j] ?? '') };
    });
    let corner = grid.corner;
    let clipped = false;
    for (const [i, line] of block.entries()) {
        for (const [j, value] of line.entries()) {
            const r = row + i;
            const c = column + j;
            if (r > rows || c > series) clipped = true;
            else if (r === 0 && c === 0) corner = chartLabel(value);
            else if (r === 0) columns[c - 1].name = chartLabel(value);
            else if (r > 0 && c === 0) next[r - 1].category = chartLabel(value);
            else if (r > 0) next[r - 1].cells[c - 1] = value.trim();
        }
    }
    return { grid: { corner, columns, rows: next }, clipped };
}

// A loop, not Math.max(...): a pasted block can have more rows than a call takes arguments.
export function widthOf(block: string[][]): number {
    let width = 0;
    for (const line of block) width = Math.max(width, line.length);
    return width;
}

// An empty value typed past the data adds nothing.
export function writeCell(grid: Grid, { row, column }: CellRef, text: string): { grid: Grid; clipped: boolean } {
    if (text === '' && (row > grid.rows.length || column > grid.columns.length)) return { grid, clipped: false };
    return fill(grid, row, column, [[text]]);
}

export function clearRange(grid: Grid, { top, bottom, left, right }: Range): Grid {
    const inside = (r: number, c: number) => r >= top && r <= bottom && c >= left && c <= right;
    return {
        corner: inside(0, 0) ? '' : grid.corner,
        columns: grid.columns.map((column, j) => (inside(0, j + 1) ? { ...column, name: '' } : column)),
        rows: grid.rows.map((row, i) => ({
            ...row,
            category: inside(i + 1, 0) ? '' : row.category,
            cells: row.cells.map((cell, j) => (inside(i + 1, j + 1) ? '' : cell)),
        })),
    };
}

// Whole rows or columns go, the header row or category column among them clears instead; the last row or
// series empties rather than leaving a chart with none.
export function removeWhole(grid: Grid, whole: 'rows' | 'columns', range: Range): Grid {
    const cleared = clearRange(grid, whole === 'rows' ? { ...range, bottom: 0 } : { ...range, right: 0 });
    if (whole === 'rows') {
        const rows = cleared.rows.filter((_, i) => i + 1 < range.top || i + 1 > range.bottom);
        return { ...cleared, rows: rows.length > 0 ? rows : [newRow(grid.columns.length)] };
    }
    const keep = (j: number) => j + 1 < range.left || j + 1 > range.right;
    const columns = cleared.columns.filter((_, j) => keep(j));
    if (columns.length === 0) return clearRange(cleared, { ...range, left: 1, top: 0, bottom: grid.rows.length });
    return {
        ...cleared,
        columns,
        rows: cleared.rows.map((row) => ({ ...row, cells: row.cells.filter((_, j) => keep(j)) })),
    };
}

function newColumn(): GridColumn {
    return { id: newChartSeriesId(), name: '' };
}

function newRow(columns: number): GridRow {
    return { origin: null, category: '', cells: Array(columns).fill('') };
}
