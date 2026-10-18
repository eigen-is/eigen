import type {
    FillStyle,
    StrokeStyle,
    TextLine,
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

// Sheets only. Zero-based, inclusive, row[0] <= row[1] and column[0] <= column[1].
export type CellRangeRef = { sheetId: string; row: [number, number]; column: [number, number] };

// markers and smooth apply to line charts only. A null color is the palette's at the series' index
// (chartColor), so a palette change reaches it and deleting a series shifts the ones after it.
export type ChartSeriesStyle = { color: string | null; markers: boolean; smooth: boolean };

export type InlineChartSeries = ChartSeriesStyle & { name: string; values: (number | null)[] };
export type RangeChartSeries = ChartSeriesStyle & { name: string | CellRangeRef; values: CellRangeRef | null };

export type InlineChartData = { source: 'inline'; categories: string[]; series: InlineChartSeries[] };
export type RangeChartData = { source: 'range'; categories: CellRangeRef | null; series: RangeChartSeries[] };

export type ChartSpec = {
    type: ChartType;
    // column and bar only
    stacking: ChartStacking;
    title: string;
    legend: LegendPosition;
    blanks: ChartBlanks;
    // visible false draws no labels and no axis line, as Excel's c:delete or a c:tickLblPos of none; the title and
    // gridlines are their own.
    // reversed runs the axis the other way from Google's, as Excel's minMax bar chart does from the bottom up: the
    // whole axis turns, so the series in a category's band turn with it.
    categoryAxis: { title: string; visible: boolean; reversed: boolean };
    // format: an Excel number format; null is General, or linked to the source cells.
    valueAxis: {
        title: string;
        min: number | null;
        max: number | null;
        gridlines: boolean;
        format: string | null;
        visible: boolean;
    };
    // pie only: one color per category, null or missing the palette's at its index, as for a series
    sliceColors: (string | null)[];
    // An EIGEN_FONTS name; every label draws in it.
    fontFamily: string;
    data: InlineChartData | RangeChartData;
};

// A chart's data with its ranges resolved: inline data as stored, or the values a sheet reads from its ranges.
export type ChartData = { categories: string[]; series: InlineChartSeries[] };
// Why a sheet's range chart has no data. 'ref': every series was deleted, or a ref names a missing sheet or
// spans rows and columns, Excel's #REF.
export type ChartDataError = 'ref' | 'too-many-points';

// What a chart paints with besides its spec's font; a canvas chart takes it from its element.
// background is a serialized Fill (transparent draws none); strokeColor and strokeStyle draw the axes and gridlines.
export type ChartPaint = {
    color: string;
    background: string;
    strokeColor: string;
    strokeWidth: number;
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
// sheet's resolved ranges or why it has none; inline data draws without it.
export type ChartSpecSvgInput = {
    id: string;
    spec: ChartSpec | null;
    data?: ChartData | ChartDataError;
    width: number;
    height: number;
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
