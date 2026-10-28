import { DEFAULT_CHART_SERIES_STYLE, defaultChartSpec, layoutChart, sampleChartSpec } from '../../charts';
import type {
    ChartAxis,
    ChartData,
    ChartLabel,
    ChartLayout,
    ChartPaint,
    ChartSeriesStyle,
    ChartSpec,
    ChartStacking,
    ChartType,
    InlineChartSeries,
} from '../../types/chart';
import { solidFill } from '../../vector/fill';
import { getLineHeightPx } from '../../vector/font-metrics';
import { measureLabel } from '../../vector/text-width';
import type { VectorElement, VectorLinearElement, VectorPieElement, VectorRectangleElement } from '../../vector/types';

export const PAINT: ChartPaint = {
    color: '#1e1e1e',
    background: solidFill('#ffffff'),
    strokeColor: '#1e1e1e',
    strokeWidth: 1,
    seriesStrokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    seed: 7,
    fillStyle: 'solid',
};

export function series(name: string, values: (number | null)[]): InlineChartSeries {
    return { id: name, name, values };
}

// A series' style: a new series' with the patch laid over.
export function style(patch: Partial<ChartSeriesStyle>): ChartSeriesStyle {
    return { ...DEFAULT_CHART_SERIES_STYLE, ...patch };
}

// Markers on every series of the data.
export function marked(data: ChartData): ChartSpec['series'] {
    return Object.fromEntries(data.series.map(({ id }) => [id, style({ marker: { visible: true } })]));
}

// Data labels on the series the ids name, every series of the data by default.
export function labeled(data: ChartData, ids = data.series.map(({ id }) => id)): ChartSpec['series'] {
    return Object.fromEntries(ids.map((id) => [id, style({ labels: { visible: true } })]));
}

// One stacking for every plot type, as the type a test draws reads its own.
export function plots(stacking: ChartStacking): ChartSpec['plots'] {
    return { column: { stacking }, bar: { stacking }, line: { stacking }, pie: { stacking } };
}

const DEFAULT_AXES = defaultChartSpec('column', { source: 'inline', categories: [], series: [] }).axes;

export type AxisPatch = { [K in keyof ChartAxis]?: ChartAxis[K] extends object ? Partial<ChartAxis[K]> : ChartAxis[K] };
export type SpecPatch = Partial<Omit<ChartSpec, 'chart' | 'axes'>> & {
    chart?: Partial<ChartSpec['chart']>;
    axes?: Partial<Record<'x' | 'y', AxisPatch>>;
};

// An axis the patch names lays over the untitled default, not the sample's titled one.
function axisOver(axis: ChartAxis, patch: AxisPatch): ChartAxis {
    return {
        kind: patch.kind ?? axis.kind,
        title: { ...axis.title, ...patch.title },
        visible: patch.visible ?? axis.visible,
        gridlines: { ...axis.gridlines, ...patch.gridlines },
        labels: { ...axis.labels, ...patch.labels },
        scale: { ...axis.scale, ...patch.scale },
    };
}

// The sample without its axis titles, for tests that measure the room left to the plot and its labels.
export const UNTITLED: SpecPatch = { axes: { x: {}, y: {} } };

type Options = {
    data?: ChartData;
    width?: number;
    height?: number;
    paint?: Partial<ChartPaint>;
    sourceFormat?: string;
};

export function sampleData(type: ChartType): ChartData {
    const { data } = sampleChartSpec(type);
    return data.source === 'inline' ? data : { categories: [], series: [] };
}

export function layout(type: ChartType, patch: SpecPatch = {}, options: Options = {}): ChartLayout {
    const sample = sampleChartSpec(type);
    const { chart, axes, ...rest } = patch;
    const axis = (id: 'x' | 'y') => {
        const over = axes?.[id];
        return over ? axisOver(DEFAULT_AXES[id], over) : sample.axes[id];
    };
    return layoutChart({
        id: 'c1',
        spec: { ...sample, ...rest, chart: { ...sample.chart, ...chart }, axes: { x: axis('x'), y: axis('y') } },
        data: options.data ?? sampleData(type),
        width: options.width ?? 640,
        height: options.height ?? 400,
        paint: { ...PAINT, ...options.paint },
        sourceFormat: options.sourceFormat,
    });
}

export function ofPart(out: ChartLayout, part: string): VectorElement[] {
    return out.shapes.filter((shape) => shape.id.split(':')[1] === part);
}

export function rects(out: ChartLayout, part: string): VectorRectangleElement[] {
    return ofPart(out, part).filter((shape): shape is VectorRectangleElement => shape.type === 'rectangle');
}

export function lines(out: ChartLayout, part: string): VectorLinearElement[] {
    return ofPart(out, part).filter((shape): shape is VectorLinearElement => shape.type === 'line');
}

export function slices(out: ChartLayout): VectorPieElement[] {
    return out.shapes.filter((shape): shape is VectorPieElement => shape.type === 'pie');
}

type Bounds = { left: number; top: number; right: number; bottom: number };

// The label's line box from measureLabel and the font's line height, turned about its anchor point.
export function labelBounds(label: ChartLabel): Bounds {
    const width = measureLabel(label.text, label.fontFamily, label.fontSize, label.bold);
    const height = getLineHeightPx(label.fontFamily, label.fontSize);
    const x0 = label.anchor === 'start' ? 0 : label.anchor === 'middle' ? -width / 2 : -width;
    const rad = (label.rotate * Math.PI) / 180;
    const corners = [
        [x0, 0],
        [x0 + width, 0],
        [x0, height],
        [x0 + width, height],
    ].map(([dx, dy]) => [
        label.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        label.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    ]);
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function shapeBounds(shape: VectorElement): Bounds {
    return { left: shape.x, top: shape.y, right: shape.x + shape.width, bottom: shape.y + shape.height };
}

export function within(bounds: Bounds, width: number, height: number): boolean {
    const slack = 0.01;
    return (
        bounds.left >= -slack &&
        bounds.top >= -slack &&
        bounds.right <= width + slack &&
        bounds.bottom <= height + slack
    );
}

export function overlaps(a: Bounds, b: Bounds): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function numbersIn(value: unknown): number[] {
    if (typeof value === 'number') return [value];
    if (typeof value === 'string' && value.startsWith('[')) return numbersIn(JSON.parse(value));
    if (Array.isArray(value)) return value.flatMap(numbersIn);
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
    return [];
}

export const SIZES: [number, number][] = [
    [640, 400],
    [1200, 675],
    [320, 200],
    [180, 120],
];
