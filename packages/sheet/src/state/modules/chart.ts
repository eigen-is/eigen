// A chart's own writers, each on one chart of the current sheet: insert, paste, its spec, its look and its data
// range, and the drawing and clipboard item made from it. The box, its order and its deletion are every floating
// object's.

import {
    applyChartSpecChange,
    CHART_DEFAULT_SIZE,
    holdsUnknownChartData,
    parseChartSpec,
    readChartLook,
    readChartSpec,
} from '@workspace/lib/charts';
import { buildChartClipboardItem } from '@workspace/lib/clipboard';
import type { SheetChart } from '@workspace/lib/sheets';
import { nextFloatingIndex, sheetFloatingBox } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartLook, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import type { EigenClipboardChartItem } from '@workspace/lib/types/clipboard';
import type { Box } from '@workspace/lib/vector';
import { randomSeed } from '@workspace/lib/vector';
import { inlineChartSpec, renderSheetChartSvg } from '../../engine/chart-data';
import type { ChartRangeRefusal } from '../../engine/chart-range';
import { chartRangeChange, currentRegion, setUpChartRange, suggestChartSpec } from '../../engine/chart-range';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { clipToUsedExtent } from '../utils';
import { editableCurrentSheet, selectFloatingObject } from './floating';
import { createContextResolver } from './formula-cache';
import { selectedCellOrigin } from './image';

// Where a chart is inserted: upright, as nothing inserts one turned.
export type ChartInsertBox = Omit<Box, 'angle'>;

// Flat, as Google's is, with a seed of its own, so a sketch picked later jitters the same everywhere.
export function insertChart(ctx: Context, id: string, box: ChartInsertBox, spec: ChartSpec) {
    addChart(ctx, id, box, JSON.stringify(spec), { seed: randomSeed() });
}

function addChart(ctx: Context, id: string, box: ChartInsertBox, spec: string, look: Partial<ChartLook>) {
    const sheet = editableCurrentSheet(ctx);
    if (!sheet) return;
    const charts = (sheet.charts ??= {});
    charts[id] = { id, index: nextFloatingIndex(sheet), ...sheetFloatingBox(box), spec, ...look };
}

// A pasted chart lands on the selected cell at its copied size, its spec and look stored as they came, and selected.
export function pasteChart(
    ctx: Context,
    id: string,
    spec: string,
    size: Pick<ChartInsertBox, 'width' | 'height'>,
    look: ChartLook,
) {
    if (!editableCurrentSheet(ctx)) return;
    addChart(ctx, id, { ...selectedCellOrigin(ctx), ...size }, spec, look);
    selectFloatingObject(ctx, { kind: 'chart', id });
}

// Applied onto the chart as the recipe finds it, so a key this build doesn't know survives, and so does a peer's edit
// of a field the change doesn't set.
export function setChartSpec(ctx: Context, id: string, change: ChartSpecChange) {
    const chart = editableCurrentSheet(ctx)?.charts?.[id];
    if (chart) chart.spec = JSON.stringify(applyChartSpecChange(readChartSpec(chart.spec).stored, change));
}

// Writes only the look fields given, each its own op, so a peer's edit of another field merges.
export function setChartLook(ctx: Context, id: string, look: Partial<ChartLook>) {
    const chart = editableCurrentSheet(ctx)?.charts?.[id];
    if (chart) Object.assign(chart, look);
}

// Insert → Chart: a column chart of the selection, or of the table around a single selected cell, below
// it at Google's default size, selected, so its panel shows. Inserts nothing and says why for a selection
// that holds no chart.
export function insertChartFromSelection(ctx: Context, id: string): ChartRangeRefusal | undefined {
    const selection = ctx.selections?.at(-1);
    if (!selection || ctx.allowEdit === false) return;
    const [{ row, column }] = clipToUsedExtent(ctx, [selection]);
    const resolver = createContextResolver(ctx);
    const ref = currentRegion(
        { sheetId: ctx.currentSheetId, row: [row[0], row[1]], column: [column[0], column[1]] },
        resolver,
    );
    const spec = suggestChartSpec(ref, resolver);
    if (typeof spec === 'string') return spec;
    const x = ref.column[0] === 0 ? 0 : ctx.visibledatacolumn[ref.column[0] - 1];
    insertChart(ctx, id, { x, y: ctx.visibledatarow[ref.row[1]], ...CHART_DEFAULT_SIZE }, spec);
    selectFloatingObject(ctx, { kind: 'chart', id });
}

// A typed data range is set up the way Insert sets up a selection, each series keeping its id and style. Data holding
// a key this build doesn't know is left as it is, as Setup and Edit data leave it.
export function setChartDataRange(ctx: Context, id: string, ref: CellRangeRef) {
    const chart = editableCurrentSheet(ctx)?.charts?.[id];
    if (!chart) return;
    const { stored, spec } = readChartSpec(chart.spec);
    if (!spec || holdsUnknownChartData(stored, spec)) return;
    const setup = setUpChartRange(ref, createContextResolver(ctx), spec.data);
    if (typeof setup !== 'string') setChartSpec(ctx, id, chartRangeChange(setup.data));
}

// One drawing per chart record and the cell matrices its ranges read. immer replaces the matrix of a
// sheet whose cells an edit touched, so an edit feeding a chart redraws it on the next render and
// nothing else does: not a selection, not a cell on another sheet.
const drawings = new WeakMap<SheetChart, { sheetIds: string[]; reads: (CellMatrix | undefined)[]; svg: string }>();

export function sheetChartSvg(ctx: Context, chart: SheetChart): string {
    const cellsOf = (sheetId: string) => ctx.sheets.find((sheet) => sheet.id === sheetId)?.data;
    const drawn = drawings.get(chart);
    if (drawn?.sheetIds.every((sheetId, i) => cellsOf(sheetId) === drawn.reads[i])) return drawn.svg;
    const data = parseChartSpec(chart.spec)?.data;
    const refs = data?.source === 'range' ? [data.categories, ...data.series.flatMap((s) => [s.name, s.values])] : [];
    const sheetIds = [...new Set(refs.flatMap((ref) => (ref && typeof ref !== 'string' ? [ref.sheetId] : [])))];
    const svg = renderSheetChartSvg(chart, createContextResolver(ctx));
    drawings.set(chart, { sheetIds, reads: sheetIds.map(cellsOf), svg });
    return svg;
}

// The chart as another app reads it, its ranges read into inline data and its look carried: what a copy writes and
// Download image draws. Null for a chart inlineChartSpec can't inline.
export function sheetChartClipboardItem(ctx: Context, chart: SheetChart): EigenClipboardChartItem | null {
    const inline = inlineChartSpec(chart, createContextResolver(ctx));
    return inline ? buildChartClipboardItem({ spec: inline, box: chart, look: readChartLook(chart) }) : null;
}
