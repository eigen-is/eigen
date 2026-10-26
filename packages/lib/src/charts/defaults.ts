// What a chart reads when it says nothing: Google's defaults for every field, the palette that colors a series or
// slice with no color of its own, and Insert → Chart's sample. The reader fills a missing or invalid field from
// defaultChartSpec, so a field added later reads its default on charts stored before it. The layout, the editors and
// the importers look up a series' style and a point's color here.

import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../constants/colors';
import { DOCUMENT_FONT } from '../constants/fonts';
import type { ChartAxisId, ChartSeriesStyle, ChartSpec, ChartType } from '../types/chart';

// Google's inserted chart, which fits the default page's 642 px text column.
export const CHART_DEFAULT_SIZE = { width: 600, height: 371 };

// Eigen's document font, which a spec that names no font, or a font Eigen doesn't bundle, reads as.
export const DEFAULT_CHART_FONT = DOCUMENT_FONT;

// Google's axes: a category axis without gridlines and a value axis with them, both shown, neither bounded.
const DEFAULT_AXES: ChartSpec['axes'] = {
    x: {
        kind: 'category',
        title: { text: '' },
        visible: true,
        gridlines: { visible: false },
        labels: { format: null },
        scale: { min: null, max: null, reversed: false },
    },
    y: {
        kind: 'value',
        title: { text: '' },
        visible: true,
        gridlines: { visible: true },
        labels: { format: null },
        scale: { min: null, max: null, reversed: false },
    },
};

// A new series, made in Eigen: in the chart's type on its value axis, its color automatic, so the palette colors it by
// position.
export const DEFAULT_CHART_SERIES_STYLE: ChartSeriesStyle = {
    plot: null,
    yAxis: 'y' satisfies ChartAxisId,
    color: null,
    line: { smooth: false },
    marker: { visible: false },
};

// What a new chart of this data starts from, and what a missing or invalid field reads as.
export function defaultChartSpec(type: ChartType, data: ChartSpec['data']): ChartSpec {
    const plot = { stacking: 'none' } as const;
    return {
        chart: { type, blanks: 'gap', fontFamily: DEFAULT_CHART_FONT },
        title: { text: '' },
        legend: { position: type === 'pie' ? 'none' : 'top' },
        axes: DEFAULT_AXES,
        plots: { column: plot, bar: plot, line: plot, pie: plot },
        series: Object.fromEntries(data.series.map(({ id }) => [id, DEFAULT_CHART_SERIES_STYLE])),
        points: {},
        data,
    };
}

// Insert → Chart's sample, one dataset for every type since the Type switch keeps the data: the share of a source's
// light per 100 nm bin from 300 to 1000 nm, Planck's law at 5772 K (Sun), 2700 K (bulb) and 10000 K (hot star), each
// source summing to 100, so the bars compare and the peak moves with temperature. A pie draws the Sun. Its labels draw in
// the host's font.
export function sampleChartSpec(type: ChartType, fontFamily = DEFAULT_CHART_FONT): ChartSpec {
    const categories = ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'];
    const sources = [
        { name: 'Sun', values: [13.1, 18.3, 18.6, 16.5, 13.7, 11.0, 8.8] },
        { name: 'Bulb (incandescent)', values: [0.3, 2.5, 7.5, 14.3, 20.9, 25.8, 28.7] },
        { name: 'Hot star', values: [32.4, 23.8, 16.2, 11.0, 7.5, 5.3, 3.8] },
    ];
    const defaults = defaultChartSpec(type, {
        source: 'inline',
        categories,
        series: (type === 'pie' ? sources.slice(0, 1) : sources).map((source, i) => ({ ...source, id: `s-${i + 1}` })),
    });
    const { x, y } = defaults.axes;
    return {
        ...defaults,
        chart: { ...defaults.chart, fontFamily },
        title: { text: "Where a star's light goes" },
        axes: {
            x: { ...x, title: { text: 'Wavelength (nm)' } },
            y: { ...y, title: { text: 'Share of light, 300–1000 nm (%)' } },
        },
    };
}

// The accent colors in the order calendars hand them out, so the first few series and every neighbor stay apart, for a
// color-blind reader too. A series or slice whose color is null draws in the one at its index.
export function chartColor(index: number): string {
    return EIGEN_ACCENT_COLORS_SHUFFLED[index % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
}

// A series' style by its id, a new series' for one a spec built in memory doesn't style.
export function chartSeriesStyle(spec: Pick<ChartSpec, 'series'>, id: string): ChartSeriesStyle {
    return Object.hasOwn(spec.series, id) ? spec.series[id] : DEFAULT_CHART_SERIES_STYLE;
}

// A point's own color, or null for one that takes the palette's color at its index.
export function chartPointColor(spec: Pick<ChartSpec, 'points'>, id: string, index: number): string | null {
    const points = Object.hasOwn(spec.points, id) ? spec.points[id] : null;
    return points && Object.hasOwn(points, index) ? points[index].color : null;
}
