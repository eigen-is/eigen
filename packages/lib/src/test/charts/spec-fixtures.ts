import { defaultChartSpec, sampleChartSpec } from '../../charts';
import type { ChartSpec, InlineChartData, RangeChartData } from '../../types/chart';

export function inlineData(seriesCount: number, pointCount: number): InlineChartData {
    return {
        source: 'inline',
        categories: Array.from({ length: pointCount }, (_, i) => `C${i}`),
        series: Array.from({ length: seriesCount }, (_, i) => ({
            id: `s-${i}`,
            name: `S${i}`,
            values: Array.from({ length: pointCount }, (_, j) => j),
        })),
    };
}

// The sample, its series styled automatic for whatever data the patch gives it.
export function chart(patch: Partial<ChartSpec> = {}): ChartSpec {
    const sample = sampleChartSpec('column');
    return { ...sample, series: defaultChartSpec('column', patch.data ?? sample.data).series, ...patch };
}

// A raw stored object, so a test can write what the type forbids.
export function stored(patch: Record<string, unknown>): string {
    return JSON.stringify({ ...sampleChartSpec('column'), ...patch });
}

export const rangeData: RangeChartData = {
    source: 'range',
    categories: { sheetId: 'sheet-1', row: [1, 4], column: [0, 0] },
    series: [
        {
            id: 's-1',
            name: { sheetId: 'sheet-1', row: [0, 0], column: [1, 1] },
            values: { sheetId: 'sheet-1', row: [1, 4], column: [1, 1] },
        },
        { id: 's-2', name: 'Literal', values: null },
    ],
};
