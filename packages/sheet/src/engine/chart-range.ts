// Google's Setup of a range chart: a block of cells derived to the refs the spec stores, and read back from them.
// The sheet's chart writers, such as Insert → Chart and the panel's Setup rows, set a chart up through it.

import { defaultChartSpec, MAX_CHART_POINTS, MAX_CHART_SERIES, newChartSeriesId } from '@workspace/lib/charts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import type {
    CellRangeRef,
    ChartSpec,
    ChartSpecChange,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import { parseA1Range, rangeToA1, sheetRefName } from './a1-notation';
import { cellLabel, resolveRangeChartData } from './chart-data';
import type { Cell, CellResolver } from './types';

// Google's Setup of a range chart: one block of cells, its series down the columns or along the rows, and
// whether the block's first row and first column hold names. The flags name the block's own row and column,
// so switching rows and columns keeps them: a text first row names the series down columns and the
// categories along rows.
export type ChartRange = { ref: CellRangeRef; seriesInRows: boolean; headerRow: boolean; headerColumn: boolean };

type SheetName = { id: string; name: string };

// Why a block holds no chart, each said in its own words by Insert's alert and the editor's Data range.
export type ChartRangeRefusal = 'too-many-series' | 'too-many-points';

export const CHART_RANGE_REFUSALS: Record<ChartRangeRefusal, string> = {
    'too-many-series': `A chart holds up to ${MAX_CHART_SERIES} series. Pick fewer rows or columns.`,
    'too-many-points': `A chart holds up to ${MAX_CHART_POINTS.toLocaleString('en')} values. Pick a smaller range.`,
};

const isText = (cell: Cell | null) => cell != null && typeof cell.v !== 'number' && cellLabel(cell) !== '';

function cellRef(sheetId: string, row: number, column: number): CellRangeRef {
    return { sheetId, row: [row, row], column: [column, column] };
}

// A text first row names series and a text first column categories, the corner cell counting for neither;
// series run down the columns unless the rows are longer.
export function suggestChartRange(ref: CellRangeRef, resolver: CellResolver): ChartRange {
    const { sheetId, row, column } = ref;
    const textIn = (rows: [number, number], columns: [number, number]) => {
        for (let r = rows[0]; r <= rows[1]; r += 1) {
            for (let c = columns[0]; c <= columns[1]; c += 1) if (isText(resolver.getCell(sheetId, r, c))) return true;
        }
        return false;
    };
    const tall = row[1] > row[0];
    const wide = column[1] > column[0];
    const headerRow = tall && textIn([row[0], row[0]], [column[0] + (wide ? 1 : 0), column[1]]);
    const headerColumn = wide && textIn([row[0] + (tall ? 1 : 0), row[1]], [column[0], column[0]]);
    const dataRows = row[1] - row[0] + 1 - (headerRow ? 1 : 0);
    const dataColumns = column[1] - column[0] + 1 - (headerColumn ? 1 : 0);
    return { ref, seriesInRows: dataColumns > dataRows, headerRow, headerColumn };
}

// The refs a block derives, each series keeping the id of the previous data's series at its index, and so its style,
// and a series past them a new id. Null when the block has no values or more series than a stored chart holds.
export function chartRangeData(
    { ref, seriesInRows, headerRow, headerColumn }: ChartRange,
    previous?: ChartSpec['data'],
): RangeChartData | null {
    const { sheetId, row, column } = ref;
    const top = row[0] + (headerRow ? 1 : 0);
    const left = column[0] + (headerColumn ? 1 : 0);
    const count = seriesInRows ? row[1] - top + 1 : column[1] - left + 1;
    if (top > row[1] || left > column[1] || count > MAX_CHART_SERIES) return null;
    const series: RangeChartSeries[] = Array.from({ length: count }, (_, i) => {
        const id = previous?.series[i]?.id ?? newChartSeriesId();
        if (seriesInRows) {
            const r = top + i;
            const values: CellRangeRef = { sheetId, row: [r, r], column: [left, column[1]] };
            return { id, name: headerColumn ? cellRef(sheetId, r, column[0]) : '', values };
        }
        const c = left + i;
        const values: CellRangeRef = { sheetId, row: [top, row[1]], column: [c, c] };
        return { id, name: headerRow ? cellRef(sheetId, row[0], c) : '', values };
    });
    const categories: CellRangeRef | null = seriesInRows
        ? headerRow
            ? { sheetId, row: [row[0], row[0]], column: [left, column[1]] }
            : null
        : headerColumn
          ? { sheetId, row: [top, row[1]], column: [column[0], column[0]] }
          : null;
    return { source: 'range', categories, series };
}

// What Setup and a typed range write: the refs alone, each series landing on the stored one with its id, so the rest of
// the data and what a newer build keeps on a series stay.
export function chartRangeChange({ categories, series }: RangeChartData): ChartSpecChange {
    return [
        { op: 'set', path: ['data', 'categories'], value: categories },
        { op: 'set', path: ['data', 'series'], value: series },
    ];
}

// The fewest values a block charts, its first row and column both names. Past what a chart draws, the block
// is refused before a cell is read, so a whole column costs nothing.
function fewestPoints({ row, column }: CellRangeRef): number {
    return Math.max(1, row[1] - row[0]) * Math.max(1, column[1] - column[0]);
}

// A block set up the way Insert and a typed range set one up, with the refs it derives, or why it holds no
// chart.
export function setUpChartRange(
    ref: CellRangeRef,
    resolver: CellResolver,
    previous?: ChartSpec['data'],
): { range: ChartRange; data: RangeChartData } | ChartRangeRefusal {
    if (fewestPoints(ref) > MAX_CHART_POINTS) return 'too-many-points';
    const range = suggestChartRange(ref, resolver);
    const data = chartRangeData(range, previous);
    if (!data) return 'too-many-series';
    if (resolveRangeChartData(data, resolver) === 'too-many-points') return 'too-many-points';
    return { range, data };
}

// The block and setup a chart's refs were derived from, or null for refs no block derives: an imported
// chart's, or one a deleted row or column nulled.
export function chartRangeOf(data: RangeChartData): ChartRange | null {
    const first = data.series[0]?.values;
    const last = data.series.at(-1)?.values;
    if (!first || !last) return null;
    const named = typeof data.series[0].name !== 'string';
    const labelled = data.categories !== null;
    const refsOf = ({ categories, series }: RangeChartData) =>
        JSON.stringify([categories, series.map(({ name, values }) => [name, values])]);
    const candidates: ChartRange[] = [
        {
            ref: {
                sheetId: first.sheetId,
                row: [first.row[0] - (named ? 1 : 0), first.row[1]],
                column: [first.column[0] - (labelled ? 1 : 0), last.column[1]],
            },
            seriesInRows: false,
            headerRow: named,
            headerColumn: labelled,
        },
        {
            ref: {
                sheetId: first.sheetId,
                row: [first.row[0] - (labelled ? 1 : 0), last.row[1]],
                column: [first.column[0] - (named ? 1 : 0), first.column[1]],
            },
            seriesInRows: true,
            headerRow: labelled,
            headerColumn: named,
        },
    ];
    return (
        candidates.find((range) => {
            const derived = chartRangeData(range);
            return derived !== null && refsOf(derived) === refsOf(data);
        }) ?? null
    );
}

// Google's Data range text: A1:D5 on the chart's own sheet, 'Other sheet'!A1:D5 elsewhere.
export function chartRangeText(range: CellRangeRef, sheets: SheetName[], ownSheetId: string) {
    if (range.sheetId === ownSheetId) return rangeToA1(range);
    const name = sheets.find((sheet) => sheet.id === range.sheetId)?.name ?? '';
    return `${sheetRefName(name)}!${rangeToA1(range)}`;
}

export function parseChartRangeText(text: string, sheets: SheetName[], ownSheetId: string): CellRangeRef | null {
    const range = parseA1Range(text.trim());
    if (!range) return null;
    const sheetId = range.sheet === undefined ? ownSheetId : sheets.find((sheet) => sheet.name === range.sheet)?.id;
    const rows: [number, number] = [Math.min(range.start.row, range.end.row), Math.max(range.start.row, range.end.row)];
    const columns: [number, number] = [
        Math.min(range.start.col, range.end.col),
        Math.max(range.start.col, range.end.col),
    ];
    if (!sheetId || rows[1] >= REFERENCE_ROW_COUNT || columns[1] >= REFERENCE_COLUMN_COUNT) return null;
    return { sheetId, row: rows, column: columns };
}

// Insert → Chart from a selection: a column chart titled after its series the way Google titles one
// ("North, South and East"), its horizontal axis after the corner cell when that heads the categories.
export function suggestChartSpec(ref: CellRangeRef, resolver: CellResolver): ChartSpec | ChartRangeRefusal {
    const setup = setUpChartRange(ref, resolver);
    if (typeof setup === 'string') return setup;
    const { range, data } = setup;
    const names = data.series
        .map(({ name }) =>
            typeof name === 'string' ? name : cellLabel(resolver.getCell(name.sheetId, name.row[0], name.column[0])),
        )
        .filter((name) => name !== '');
    const title = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
    const corner = range.headerRow && range.headerColumn && !range.seriesInRows;
    const axisTitle = corner ? cellLabel(resolver.getCell(ref.sheetId, ref.row[0], ref.column[0])) : '';
    const defaults = defaultChartSpec('column', data);
    const { x } = defaults.axes;
    return { ...defaults, title: { text: title }, axes: { ...defaults.axes, x: { ...x, title: { text: axisTitle } } } };
}

// Excel's current region: a single cell grows to the block of filled cells around it, the way Google
// charts the table the cursor is in. A range stays as selected. Each edge grows as far as it goes before
// the next is tried, so a long side is read once per turn rather than once per added row, and growing stops
// past the values a chart draws, a block the setup then refuses.
export function currentRegion(ref: CellRangeRef, resolver: CellResolver): CellRangeRef {
    if (ref.row[0] !== ref.row[1] || ref.column[0] !== ref.column[1]) return ref;
    const { sheetId } = ref;
    const filled = (r: number, c: number) => r >= 0 && c >= 0 && cellLabel(resolver.getCell(sheetId, r, c)) !== '';
    const anyIn = (rows: [number, number], columns: [number, number]) => {
        for (let r = rows[0]; r <= rows[1]; r += 1) {
            for (let c = columns[0]; c <= columns[1]; c += 1) if (filled(r, c)) return true;
        }
        return false;
    };
    let [top, bottom] = ref.row;
    let [left, right] = ref.column;
    if (!filled(top, left)) return ref;
    const region = (): CellRangeRef => ({ sheetId, row: [top, bottom], column: [left, right] });
    const room = () => fewestPoints(region()) <= MAX_CHART_POINTS;
    for (let grown = true; grown; ) {
        grown = false;
        while (room() && top > 0 && anyIn([top - 1, top - 1], [left - 1, right + 1])) [top, grown] = [top - 1, true];
        while (room() && anyIn([bottom + 1, bottom + 1], [left - 1, right + 1])) [bottom, grown] = [bottom + 1, true];
        while (room() && left > 0 && anyIn([top - 1, bottom + 1], [left - 1, left - 1]))
            [left, grown] = [left - 1, true];
        while (room() && anyIn([top - 1, bottom + 1], [right + 1, right + 1])) [right, grown] = [right + 1, true];
    }
    return region();
}
