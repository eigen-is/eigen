// The chart fixture for this workspace's suites: a fixture stores a chart only as a new chart's parts, never as a
// hand-written part, so a change to the parts reaches every suite through one helper.

import { chartSeriesStyle, defaultChartSpec, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartSpec, ChartType } from '@workspace/lib/types/chart';

// The sample chart of a type, stored as a new chart's parts.
export function sampleChartParts(type: ChartType, fontFamily?: string) {
    return newChartSpecParts(sampleChartSpec(type, fontFamily));
}

const DEFAULT_AXES = defaultChartSpec('column', { source: 'inline', categories: [], series: [] }).axes;

// The spec with data labels on the series the ids name.
export function withDataLabels(spec: ChartSpec, ids: string[]): ChartSpec {
    const series = ids.map((id) => [id, { ...chartSeriesStyle(spec, id), labels: { visible: true } }]);
    return { ...spec, series: { ...spec.series, ...Object.fromEntries(series) } };
}

// A spec as a chart part reads back: a pie has no axes, so the axis fields a Type switch would show read as a new
// pie's, its values' format aside, which the values carry.
export function axesOf(spec: ChartSpec): ChartSpec {
    if (spec.chart.type !== 'pie') return spec;
    const { x, y } = DEFAULT_AXES;
    return { ...spec, axes: { x, y: { ...y, labels: spec.axes.y.labels } } };
}
