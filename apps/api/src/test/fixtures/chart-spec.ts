import type { ChartSpec } from '@workspace/lib/types/chart';

// Eigen's chart writer writes no series id, so a chart read back from Office names its series by c:idx. A round trip
// compares specs with every series id set to its place, s-1 first, as the fixtures and the sample number them.
export function seriesIdsByPlace(spec: ChartSpec): ChartSpec {
    const id = (i: number) => `s-${i + 1}`;
    const { data } = spec;
    return {
        ...spec,
        data:
            data.source === 'inline'
                ? { ...data, series: data.series.map((series, i) => ({ ...series, id: id(i) })) }
                : { ...data, series: data.series.map((series, i) => ({ ...series, id: id(i) })) },
    };
}
