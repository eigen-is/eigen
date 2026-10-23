import { parseChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { generateKeyBetween, orderByFractionalIndex } from '@workspace/lib/vector';
import type { Patch } from 'immer';
import { renderSheetChartSvg } from '../../engine/chart-data';
import { type ChartRangeRefusal, currentRegion, setUpChartRange, suggestChartSpec } from '../../engine/chart-range';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { clipToUsedExtent, getSheetIndex } from '../utils';
import { createContextResolver } from './formula-cache';
import { selectedCellOrigin } from './image';

// Each writer touches one chart of the current sheet and nothing else, field by field, so a batch
// on a chart a peer deleted fails whole on every client and in the replay. What writes a whole chart
// brings one a peer deleted back on every client, last writer wins: redoing its insert, undoing its
// delete, and undoing or redoing a row or column op that shifted it.

export type ChartBox = Pick<SheetChart, 'x' | 'y' | 'width' | 'height'>;

function currentSheet(ctx: Context) {
    if (ctx.allowEdit === false) return undefined;
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    return index == null ? undefined : ctx.sheets[index];
}

export function insertChart(ctx: Context, id: string, box: ChartBox, spec: ChartSpec) {
    addChart(ctx, id, box, JSON.stringify(spec));
}

function addChart(ctx: Context, id: string, box: ChartBox, spec: string) {
    const sheet = currentSheet(ctx);
    if (!sheet) return;
    const charts = (sheet.charts ??= {});
    const top = orderByFractionalIndex(Object.values(charts)).at(-1);
    charts[id] = { id, index: generateKeyBetween(top?.index, null), ...box, spec };
}

// A pasted chart lands on the selected cell at its copied size, its spec stored as it came, and selected.
export function pasteChart(ctx: Context, id: string, spec: string, size: Pick<ChartBox, 'width' | 'height'>) {
    if (!currentSheet(ctx)) return;
    addChart(ctx, id, { ...selectedCellOrigin(ctx), ...size }, spec);
    selectChart(ctx, id);
}

export function updateChartBox(ctx: Context, id: string, box: Partial<ChartBox>) {
    const chart = currentSheet(ctx)?.charts?.[id];
    if (chart) Object.assign(chart, box);
}

export function setChartSpec(ctx: Context, id: string, spec: ChartSpec) {
    const chart = currentSheet(ctx)?.charts?.[id];
    if (chart) chart.spec = JSON.stringify(spec);
}

// One step up or down the paint order. A neighbor tied on index is passed along with it, since no
// key sorts between two equal keys.
export function reorderChart(ctx: Context, id: string, direction: 'forward' | 'backward') {
    const charts = currentSheet(ctx)?.charts;
    const chart = charts?.[id];
    if (!charts || !chart) return;
    const order = orderByFractionalIndex(Object.values(charts));
    const at = order.findIndex((c) => c.id === id);
    if (direction === 'forward') {
        const next = order[at + 1];
        if (!next) return;
        const above = order.slice(at + 2).find((c) => c.index > next.index);
        chart.index = generateKeyBetween(next.index, above?.index);
    } else {
        const previous = order[at - 1];
        if (!previous) return;
        const below = order.slice(0, at - 1).findLast((c) => c.index < previous.index);
        chart.index = generateKeyBetween(below?.index, previous.index);
    }
}

export function deleteChart(ctx: Context, id: string) {
    const charts = currentSheet(ctx)?.charts;
    if (charts?.[id]) delete charts[id];
}

// A field patch on a chart a peer deleted cannot resolve, and immer throws on it; the chart's own
// add and remove (path ending at its id) still apply.
export function editsDeletedChart(ctx: Context, patches: Patch[]): boolean {
    return patches.some(({ path: [root, sheet, field, id, ...rest] }) => {
        if (root !== 'sheets' || typeof sheet !== 'number' || field !== 'charts' || rest.length === 0) return false;
        return ctx.sheets[sheet]?.charts?.[id] == null;
    });
}

// Google's default chart size.
const NEW_CHART_SIZE = { width: 600, height: 371 };

// Insert → Chart: a column chart of the selection, or of the table around a single selected cell, below
// it at Google's default size, selected with its editor open. Inserts nothing and says why for a selection
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
    insertChart(ctx, id, { x, y: ctx.visibledatarow[ref.row[1]], ...NEW_CHART_SIZE }, spec);
    selectChart(ctx, id, true);
}

// A typed data range is set up the way Insert sets up a selection, each series keeping its style.
export function setChartDataRange(ctx: Context, id: string, ref: CellRangeRef) {
    const chart = currentSheet(ctx)?.charts?.[id];
    const spec = chart ? parseChartSpec(chart.spec) : null;
    if (!spec) return;
    const styles = spec.data.series.map(({ color, markers, smooth }) => ({ color, markers, smooth }));
    const setup = setUpChartRange(ref, createContextResolver(ctx), styles);
    if (typeof setup !== 'string') setChartSpec(ctx, id, { ...spec, data: setup.data });
}

// Selecting a chart keeps its editor open when another chart's was.
export function selectChart(ctx: Context, id: string, editor = false) {
    ctx.activeImg = undefined;
    ctx.activeChart = { id, editor: editor || ctx.activeChart?.editor === true };
}

export function deleteActiveChart(ctx: Context) {
    if (!ctx.activeChart) return;
    deleteChart(ctx, ctx.activeChart.id);
    ctx.activeChart = undefined;
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
