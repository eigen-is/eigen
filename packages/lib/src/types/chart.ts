import type { FillStyle, StrokeStyle, VectorElement } from '../vector/types';

// Google/Excel names: `column` draws vertical bars, `bar` horizontal ones.
export const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;
export const LEGEND_POSITIONS = ['top', 'bottom', 'left', 'right', 'none'] as const;
// DrawingML dispBlanksAs: how a null value draws.
export const CHART_BLANKS = ['gap', 'zero', 'span'] as const;

export type ChartType = (typeof CHART_TYPES)[number];
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];
export type ChartBlanks = (typeof CHART_BLANKS)[number];

// Sheets only. Zero-based, inclusive, row[0] <= row[1] and column[0] <= column[1].
export type CellRangeRef = { sheetId: string; row: [number, number]; column: [number, number] };

// markers and smooth apply to line charts only.
export type ChartSeriesStyle = { color: string; markers: boolean; smooth: boolean };

export type InlineChartSeries = ChartSeriesStyle & { name: string; values: (number | null)[] };
export type RangeChartSeries = ChartSeriesStyle & { name: string | CellRangeRef; values: CellRangeRef | null };

export type InlineChartData = { source: 'inline'; categories: string[]; series: InlineChartSeries[] };
export type RangeChartData = { source: 'range'; categories: CellRangeRef | null; series: RangeChartSeries[] };

export type ChartSpec = {
    type: ChartType;
    // column and bar only
    stacked: boolean;
    title: string;
    legend: LegendPosition;
    blanks: ChartBlanks;
    categoryAxis: { title: string };
    // format: an Excel number format; null is General, or linked to the source cells.
    valueAxis: { title: string; min: number | null; max: number | null; gridlines: boolean; format: string | null };
    // pie only: one color per category, stored at creation
    sliceColors: string[];
    data: InlineChartData | RangeChartData;
};

// A chart's data with its ranges resolved: inline data as stored, or the values a sheet reads from its ranges.
export type ChartData = { categories: string[]; series: InlineChartSeries[] };

// What a chart paints with: a canvas chart takes it from its element, docs and sheets use one flat preset.
// background is a serialized Fill (transparent draws none); strokeColor and strokeStyle draw the axes and gridlines.
export type ChartPaint = {
    fontFamily: string;
    color: string;
    background: string;
    strokeColor: string;
    strokeWidth: number;
    strokeStyle: StrokeStyle;
    roughness: number;
    seed: number;
    fillStyle: FillStyle;
};

// One line of chart text. y is the line's TOP: a renderer adds the font's baseline offset, a rich-text box
// takes it as its top. The label turns `rotate` degrees (0, -45 or -90) about (x, y).
export type ChartLabel = {
    text: string;
    x: number;
    y: number;
    anchor: 'start' | 'middle' | 'end';
    fontFamily: string;
    fontSize: number;
    bold: boolean;
    color: string;
    rotate: number;
};

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

// shapes are in paint order: background, gridlines, bars or slices, lines, markers, baseline, legend swatches.
export type ChartLayout = { shapes: VectorElement[]; labels: ChartLabel[] };
