// The chart spec every chart host stores, such as a canvas element, a Docs node or a sheet's chart, and the change an
// editor hands its host. Shared by every package that reads, edits, draws or converts a chart.

import type {
    FillStyle,
    StrokeStyle,
    TextLine,
    VectorChartElement,
    VectorEllipseElement,
    VectorLinearElement,
    VectorPieElement,
    VectorRectangleElement,
} from '../vector/types';

// Google/Excel names: `column` draws vertical bars, `bar` horizontal ones.
export const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;
export const LEGEND_POSITIONS = ['top', 'bottom', 'left', 'right', 'none'] as const;
// DrawingML dispBlanksAs: how a null value draws.
export const CHART_BLANKS = ['gap', 'zero', 'span'] as const;
// Excel's grouping: percent stacks each category's values as shares of their absolute sum.
export const CHART_STACKINGS = ['none', 'stacked', 'percent'] as const;

export type ChartType = (typeof CHART_TYPES)[number];
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];
export type ChartBlanks = (typeof CHART_BLANKS)[number];
export type ChartStacking = (typeof CHART_STACKINGS)[number];

// Column and bar charts stack their series by their plot's stacking. A line or a pie keeps a stacking it is given, but
// draws its series apart.
export function isStackingChartType(type: ChartType): boolean {
    return type === 'column' || type === 'bar';
}

// Sheets only. Zero-based, inclusive, row[0] <= row[1] and column[0] <= column[1].
export type CellRangeRef = { sheetId: string; row: [number, number]; column: [number, number] };

// Fixed, never minted, so two peers who each add the second value axis write the same key: x the category axis (up a
// bar chart's side), y the value axis, x2 and y2 the second pair. This build draws x and y and keeps the others.
export const CHART_AXIS_IDS = ['x', 'y', 'x2', 'y2'] as const;
export const CHART_AXIS_KINDS = ['category', 'value'] as const;

export type ChartAxisId = (typeof CHART_AXIS_IDS)[number];
export type ChartAxisKind = (typeof CHART_AXIS_KINDS)[number];

// visible false draws no labels and no axis line, as Excel's c:delete or a c:tickLblPos of none; the title and
// gridlines are their own. format is an Excel number format, null General or linked to the source cells. min and max
// bound a value axis. reversed runs a category axis the other way from Google's, as Excel's minMax bar chart does from
// the bottom up: the whole axis turns, so the series in a category's band turn with it.
export type ChartAxis = {
    kind: ChartAxisKind;
    title: { text: string };
    visible: boolean;
    gridlines: { visible: boolean };
    labels: { format: string | null };
    scale: { min: number | null; max: number | null; reversed: boolean };
};

// A plot type's own options, which every series drawn in that type shares. stacking: column and bar only.
export type ChartPlot = { stacking: ChartStacking };

// A series' style, by its id. plot null draws in the chart's type, and yAxis names the axis it plots against; this build
// draws every series in the chart's type on y. A null color is the palette's at the series' index (chartColor), so a
// palette change reaches it and deleting a series shifts the ones after it. line and marker apply to line charts only.
export type ChartSeriesStyle = {
    plot: ChartType | null;
    yAxis: string;
    color: string | null;
    line: { smooth: boolean };
    marker: { visible: boolean };
};

// One point's style over its series', by the point's index. A pie's slices are its first series' points, and a null
// color is automatic: the palette's at the slice's index.
export type ChartPoint = { color: string | null };

// id is stable across a delete or a reorder and unique in its chart, so the styles keyed by it follow their series.
export type InlineChartSeries = { id: string; name: string; values: (number | null)[] };
export type RangeChartSeries = { id: string; name: string | CellRangeRef; values: CellRangeRef | null };

export type InlineChartData = { source: 'inline'; categories: string[]; series: InlineChartSeries[] };
export type RangeChartData = { source: 'range'; categories: CellRangeRef | null; series: RangeChartSeries[] };

// The spec's eight parts, each a record, so a later option nests in one and an older build keeps it. fontFamily is an
// EIGEN_FONTS name every label draws in. axes holds the axes this build draws, the ids' first pair, series a style per
// series id in data, points the styled points by series id and index.
export type ChartSpec = {
    chart: { type: ChartType; blanks: ChartBlanks; fontFamily: string };
    title: { text: string };
    legend: { position: LegendPosition };
    axes: Record<(typeof CHART_AXIS_IDS)[0 | 1], ChartAxis>;
    plots: Record<ChartType, ChartPlot>;
    series: Record<string, ChartSeriesStyle>;
    points: Record<string, Record<number, ChartPoint>>;
    data: InlineChartData | RangeChartData;
};

// Each part is stored apart, so two peers who edit two parts both keep their edit, and the set never grows: a later
// option nests in a part. The number is how far down Sheets stores the part an entry per key, 0 as one string.
export const CHART_SPEC_PARTS = {
    chart: 0,
    title: 0,
    legend: 0,
    axes: 1,
    plots: 1,
    series: 1,
    points: 2,
    data: 0,
} as const satisfies Record<keyof ChartSpec, number>;

export type ChartSpecPart = keyof typeof CHART_SPEC_PARTS;
// The parts Sheets stores an entry per key: axes by id, plots by type, series by id, points by series id and index.
export type ChartSpecKeyedPart = {
    [P in ChartSpecPart]: (typeof CHART_SPEC_PARTS)[P] extends 0 ? never : P;
}[ChartSpecPart];
// A part's key on the record a host stores, an element, a node's attributes or a sheet's chart: specChart … specData.
export type ChartSpecPartKey<P extends ChartSpecPart = ChartSpecPart> = `spec${Capitalize<P>}`;

// Spelled out, since a capital made at run time types as a string; the type holds each to its part's.
export const CHART_SPEC_PART_KEY = {
    chart: 'specChart',
    title: 'specTitle',
    legend: 'specLegend',
    axes: 'specAxes',
    plots: 'specPlots',
    series: 'specSeries',
    points: 'specPoints',
    data: 'specData',
} as const satisfies { [P in ChartSpecPart]: ChartSpecPartKey<P> };

export const CHART_SPEC_PART_KEYS = Object.values(CHART_SPEC_PART_KEY);

// A chart's parts as a canvas and a doc store them and the clipboard carries them: each prefixed key's JSON text, this
// build's parts and a newer one's, parsed or not.
export type ChartSpecTexts = { readonly [key: string]: string };

// A chart's parts on Sheets: a keyed part a record from each entry's path, / -joined, to that entry's JSON, so two
// peers who edit two entries both keep their edit; the other parts a JSON string each.
export type SheetChartSpecParts = {
    [P in ChartSpecPart as ChartSpecPartKey<P>]: P extends ChartSpecKeyedPart ? Record<string, string> : string;
};

// One write of a Sheets chart: a part set whole, or one entry of a keyed part set or, at null, removed.
export type SheetChartSpecWrite =
    | { key: ChartSpecPartKey<Exclude<ChartSpecPart, ChartSpecKeyedPart>>; value: string }
    | { key: ChartSpecPartKey<ChartSpecKeyedPart>; entry: string; value: string | null };

// A stored spec as JSON.parse made it, whole or a part at a time, unvalidated: every key a peer stored, this build's or
// a newer one's.
export type StoredChartSpec = { readonly [key: string]: unknown };

// An edit of a chart, as ops on paths into its stored spec, so what an editor didn't touch stays as stored. An array is
// a leaf, set whole. move takes what is at from to path; nothing at from leaves nothing at path.
export type ChartSpecOp =
    | { op: 'set'; path: string[]; value: unknown }
    | { op: 'remove'; path: string[] }
    | { op: 'move'; from: string[]; path: string[] };
export type ChartSpecChange = ChartSpecOp[];

// A chart's data with its ranges resolved: inline data as stored, or the values a sheet reads from its ranges.
export type ChartData = { categories: string[]; series: InlineChartSeries[] };
// Why a sheet's range chart has no data. 'ref': every series was deleted, or a ref names a missing sheet or
// spans rows and columns, Excel's #REF.
export type ChartDataError = 'ref' | 'too-many-points';

// A chart's look: the fields a canvas chart element paints with, which a doc's and a sheet's chart store under the
// same names beside the spec. Opacity is a canvas layer's, not the chart's.
export const CHART_LOOK_FIELDS = [
    'fill',
    'color',
    'strokeColor',
    'strokeWidth',
    'seriesStrokeWidth',
    'strokeStyle',
    'roughness',
    'seed',
] as const satisfies readonly (keyof VectorChartElement)[];

export type ChartLook = Pick<VectorChartElement, (typeof CHART_LOOK_FIELDS)[number]>;

// What a chart paints with besides its spec's font, from its look (chartPaintOf).
// background is a serialized Fill, and a transparent one draws none. strokeColor and strokeStyle draw the axes and
// gridlines. seriesStrokeWidth is the width of a line series.
export type ChartPaint = {
    color: string;
    background: string;
    strokeColor: string;
    strokeWidth: number;
    seriesStrokeWidth: number;
    strokeStyle: StrokeStyle;
    roughness: number;
    seed: number;
    fillStyle: FillStyle;
};

// One line of chart text, turned 0, -45 or -90 degrees; Convert to shapes takes its y as a rich-text box's top.
export type ChartLabel = TextLine;

// The chart's box is width × height from (0, 0); every shape and label is in those local coordinates.
// formatTick draws a value-axis label for a tick and the step between ticks.
export type ChartLayoutInput = {
    id: string;
    spec: ChartSpec;
    data: ChartData;
    width: number;
    height: number;
    paint: ChartPaint;
    formatTick: (value: number, step: number) => string;
};

// The box and paint every layout starts from, a message's included.
export type ChartBox = Pick<ChartLayoutInput, 'id' | 'width' | 'height' | 'paint'>;

// A chart outside a canvas, in a document or on a sheet: spec null for one that doesn't parse, and data the
// sheet's resolved ranges or why it has none; inline data draws without it. No look draws flat.
export type ChartSpecSvgInput = {
    id: string;
    spec: ChartSpec | null;
    data?: ChartData | ChartDataError;
    width: number;
    height: number;
    look?: ChartLook;
    formatTick?: ChartLayoutInput['formatTick'];
};

// The elements a chart draws with: rectangles, lines, marker ellipses and pie slices.
export type ChartShape =
    | VectorRectangleElement
    | (VectorLinearElement & { type: 'line' })
    | VectorEllipseElement
    | VectorPieElement;

// shapes are in paint order: background, gridlines, bars or slices, lines, markers, baseline, legend swatches.
export type ChartLayout = { shapes: ChartShape[]; labels: ChartLabel[] };
