import type { ChartSpec } from '@workspace/lib/types/chart';

// Eigen's chart writer writes no series id, so a chart read back from Office names its series by c:idx. A round trip
// compares specs with every series id set to its place, s-1 first, as the fixtures and the sample number them, and the
// styles and points keyed by an id follow it.
export function seriesIdsByPlace(spec: ChartSpec): ChartSpec {
    const { data } = spec;
    const ids = new Map(data.series.map(({ id }, i) => [id, `s-${i + 1}`]));
    const id = (old: string) => ids.get(old) ?? old;
    const rekeyed = <T>(record: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(record).map(([key, value]) => [id(key), value]));
    return {
        ...spec,
        series: rekeyed(spec.series),
        points: rekeyed(spec.points),
        data:
            data.source === 'inline'
                ? { ...data, series: data.series.map((series) => ({ ...series, id: id(series.id) })) }
                : { ...data, series: data.series.map((series) => ({ ...series, id: id(series.id) })) },
    };
}
