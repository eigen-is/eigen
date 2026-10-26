// The chart's drawing body: the layout's shapes, each drawn by its own kind in its own group, then the
// labels as SVG text. It is split from the chart kind, as the arrow's painter is. The shape kinds are
// imported one by one, never through the registry, which imports the chart kind.

import {
    CHART_MESSAGES,
    chartPaintOf,
    DEFAULT_CHART_FONT,
    FLAT_CHART_LOOK,
    formatTickValue,
    layoutChart,
    layoutChartMessage,
    readChartSpec,
} from '../../charts';
import type { ChartBox, ChartDataError, ChartLayout, ChartShape, ChartSpecSvgInput } from '../../types/chart';
import { round } from '../points';
import type { VectorChartElement } from '../types';
import { ellipseKind } from './ellipse';
import type { ElementKind } from './kind';
import { lineKind } from './line';
import { pieKind } from './pie';
import { rectangleKind } from './rectangle';
import { elementGroupOpen, PLACEHOLDER_STROKE, SVG_NS, svgTextLine } from './render-utils';

const SHAPE_KINDS: Record<ChartShape['type'], ElementKind> = {
    rectangle: rectangleKind,
    line: lineKind,
    ellipse: ellipseKind,
    pie: pieKind,
};

const DATA_ERROR_MESSAGES: Record<ChartDataError, string> = {
    ref: CHART_MESSAGES.ref,
    'too-many-points': CHART_MESSAGES.tooManyPoints,
};

export function renderChartSvg(el: VectorChartElement): string {
    return chartBodySvg(chartBox(el), chartElementLayout(el));
}

// A complete <svg> of the box in its look and the spec's font, which a document's HTML inlines and a sheet overlays.
export function renderChartSpecSvg({
    spec,
    data,
    look = FLAT_CHART_LOOK,
    formatTick = formatTickValue,
    ...rest
}: ChartSpecSvgInput): string {
    const box = { ...rest, paint: chartPaintOf(look) };
    const resolved = data ?? (spec?.data.source === 'inline' ? spec.data : null);
    let body: string;
    if (spec === null || resolved === null) body = chartBodySvg(box, null);
    else if (typeof resolved === 'string')
        body = layoutSvg(layoutChartMessage(box, DATA_ERROR_MESSAGES[resolved], spec.chart.fontFamily));
    else body = layoutSvg(layoutChart({ ...box, spec, data: resolved, formatTick }));
    const width = round(Math.max(0, box.width));
    const height = round(Math.max(0, box.height));
    return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

// What the chart draws, which Convert to shapes unpacks too; null for the placeholder. A canvas has no sheet
// to read range data from; a malformed spec stays stored for recovery.
export function chartElementLayout(el: VectorChartElement): ChartLayout | null {
    const { spec } = readChartSpec(el);
    if (spec === null || spec.data.source !== 'inline') return null;
    return layoutChart({ ...chartBox(el), spec, data: spec.data, formatTick: formatTickValue });
}

// The layout, or for null the placeholder: a dashed box and one centered line, in the default font since
// a spec that doesn't parse names none.
function chartBodySvg(box: ChartBox, layout: ChartLayout | null): string {
    if (layout) return layoutSvg(layout);
    const outline = `<rect x="0" y="0" width="${round(box.width)}" height="${round(box.height)}" ${PLACEHOLDER_STROKE}/>`;
    return outline + layoutSvg(layoutChartMessage(box, CHART_MESSAGES.unreadable, DEFAULT_CHART_FONT));
}

// The element's own fields are its look; the font is the spec's.
function chartBox(el: VectorChartElement): ChartBox {
    return { id: el.id, width: el.width, height: el.height, paint: chartPaintOf(el) };
}

// Shape ids are `${chartId}:…`, so each one's scoped defs ids stay unique on the page.
function layoutSvg({ shapes, labels }: ChartLayout): string {
    return shapes.map(shapeSvg).join('') + labels.map(svgTextLine).join('');
}

function shapeSvg(shape: ChartShape): string {
    const body = SHAPE_KINDS[shape.type].render(shape, {}).svg;
    return body === '' ? '' : `${elementGroupOpen(shape)}${body}</g>`;
}
