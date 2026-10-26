// The chart fixture for this workspace's suites: a fixture stores a chart only as a new chart's parts, never as a
// hand-written part, so a change to the parts reaches every suite through one helper.

import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartType } from '@workspace/lib/types/chart';

// The sample chart of a type, stored as a new chart's parts.
export function sampleChartParts(type: ChartType, fontFamily?: string) {
    return newChartSpecParts(sampleChartSpec(type, fontFamily));
}
