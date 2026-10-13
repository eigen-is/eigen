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
