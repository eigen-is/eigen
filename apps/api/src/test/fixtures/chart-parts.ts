// The chart fixture for this workspace's suites: a fixture stores a chart only as a new chart's parts, never as a
// hand-written part, so a change to the parts reaches every suite through one helper.

import { defaultChartSpec, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartSpec, ChartType } from '@workspace/lib/types/chart';

// The sample chart of a type, stored as a new chart's parts.
export function sampleChartParts(type: ChartType, fontFamily?: string) {
    return newChartSpecParts(sampleChartSpec(type, fontFamily));
}

const DEFAULT_AXES = defaultChartSpec('column', { source: 'inline', categories: [], series: [] }).axes;

// A spec as a chart part reads back: a pie has no axes, so the axis fields a Type switch would show read as an Excel
// pie's, no titles and no gridlines.
export function axesOf(spec: ChartSpec): ChartSpec {
    if (spec.chart.type !== 'pie') return spec;
    const { x, y } = DEFAULT_AXES;
    return { ...spec, axes: { x, y: { ...y, gridlines: { visible: false } } } };
}
