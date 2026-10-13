import type { SheetChart } from '@workspace/lib/sheets';
import type { ChartSpec } from '@workspace/lib/types/chart';
import { generateKeyBetween, orderByFractionalIndex } from '@workspace/lib/vector';
import type { Patch } from 'immer';
import type { Context } from '../context';
import { getSheetIndex } from '../utils';

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
    const sheet = currentSheet(ctx);
    if (!sheet) return;
    const charts = (sheet.charts ??= {});
    const top = orderByFractionalIndex(Object.values(charts)).at(-1);
    charts[id] = { id, index: generateKeyBetween(top?.index, null), ...box, spec: JSON.stringify(spec) };
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
