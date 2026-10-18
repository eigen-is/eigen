// The chart's drawing body: the layout's shapes, each drawn by its own kind in its own group, then the
// labels as SVG text. Split from the kind like arrow-render.ts. The kinds are imported one by one, never
// through the registry, which imports the chart kind.

import {
    CHART_MESSAGES,
    DEFAULT_CHART_FONT,
    FLAT_CHART_PAINT,
    formatTickValue,
    layoutChart,
    layoutChartMessage,
    parseChartSpec,
} from '../../charts';
import type { ChartBox, ChartDataError, ChartLayout, ChartShape, ChartSpecSvgInput } from '../../types/chart';
import { parseFill } from '../fill';
import { round } from '../geometry';
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

export function renderChartSvg(el: VectorChartElement): string {
    return chartBodySvg(chartBox(el), chartLayout(el));
}

// A complete <svg> of the box in the flat paint and the spec's font, which a document's HTML inlines and a
// sheet overlays.
export function renderChartSpecSvg({ spec, data, formatTick = formatTickValue, ...rest }: ChartSpecSvgInput): string {
    const box = { ...rest, paint: FLAT_CHART_PAINT };
    const resolved = data ?? (spec?.data.source === 'inline' ? spec.data : null);
    let body: string;
    if (spec === null || resolved === null) body = chartBodySvg(box, null);
    else if (typeof resolved === 'string')
        body = layoutSvg(layoutChartMessage(box, dataErrorMessage(resolved), spec.fontFamily));
    else body = layoutSvg(layoutChart({ ...box, spec, data: resolved, formatTick }));
    const width = round(Math.max(0, box.width));
    const height = round(Math.max(0, box.height));
    return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

// What the chart draws, which Convert to shapes unpacks too; null for the placeholder. A canvas has no sheet
// to read range data from; a malformed spec stays stored for recovery.
export function chartLayout(el: VectorChartElement): ChartLayout | null {
    const spec = parseChartSpec(el.chart);
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

// Built per call: charts/ reaches this module through geometry's import of the kinds, so CHART_MESSAGES
// isn't initialized yet when this module evaluates.
function dataErrorMessage(error: ChartDataError): string {
    const messages: Record<ChartDataError, string> = {
        ref: CHART_MESSAGES.ref,
        'too-many-points': CHART_MESSAGES.tooManyPoints,
    };
    return messages[error];
}

// The fill's paint is the background and its hatch style the marks'; the stroke draws axes and gridlines.
// The font is the spec's.
function chartBox(el: VectorChartElement): ChartBox {
    return {
        id: el.id,
        width: el.width,
        height: el.height,
        paint: {
            color: el.color,
            background: el.fill,
            strokeColor: el.strokeColor,
            strokeWidth: el.strokeWidth,
            strokeStyle: el.strokeStyle,
            roughness: el.roughness,
            seed: el.seed,
            fillStyle: parseFill(el.fill).style,
        },
    };
}

// Shape ids are `${chartId}:…`, so each one's scoped defs ids stay unique on the page.
function layoutSvg({ shapes, labels }: ChartLayout): string {
    return shapes.map(shapeSvg).join('') + labels.map(svgTextLine).join('');
}

function shapeSvg(shape: ChartShape): string {
    const body = SHAPE_KINDS[shape.type].render(shape, {}).svg;
    return body === '' ? '' : `${elementGroupOpen(shape)}${body}</g>`;
}
