// The chart's drawing body: the layout's shapes, each drawn by its own kind in its own group, then the
// labels as SVG text. Split from the kind like arrow-render.ts. The kinds are imported one by one, never
// through the registry, which imports the chart kind.

import { formatTickValue, layoutChart, layoutChartMessage, parseChartSpec } from '../../charts';
import type { ChartLayout, ChartPaint } from '../../types/chart';
import { parseFill } from '../fill';
import { round } from '../geometry';
import type { VectorChartElement, VectorElement } from '../types';
import { ellipseKind } from './ellipse';
import { lineKind } from './line';
import { pieKind } from './pie';
import { rectangleKind } from './rectangle';
import { elementGroupOpen, PLACEHOLDER_COLOR, PLACEHOLDER_DASH, svgTextLine } from './render-utils';

const UNREADABLE_MESSAGE = "This chart can't be shown";

const SHAPE_KINDS = [rectangleKind, lineKind, ellipseKind, pieKind];

export function renderChartSvg(el: VectorChartElement): string {
    const box = { id: el.id, width: el.width, height: el.height, paint: chartPaint(el) };
    const spec = parseChartSpec(el.chart);
    // A canvas has no sheet to read range data from; a malformed spec stays stored for recovery.
    if (spec === null || spec.data.source !== 'inline') {
        const outline = `<rect x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" fill="none" stroke="${PLACEHOLDER_COLOR}" stroke-width="1" stroke-dasharray="${PLACEHOLDER_DASH}"/>`;
        return outline + layoutSvg(layoutChartMessage(box, UNREADABLE_MESSAGE));
    }
    return layoutSvg(layoutChart({ ...box, spec, data: spec.data, formatTick: formatTickValue }));
}

// The fill's paint is the background and its hatch style the marks'; the stroke draws axes and gridlines.
function chartPaint(el: VectorChartElement): ChartPaint {
    return {
        fontFamily: el.fontFamily,
        color: el.color,
        background: el.fill,
        strokeColor: el.strokeColor,
        strokeWidth: el.strokeWidth,
        strokeStyle: el.strokeStyle,
        roughness: el.roughness,
        seed: el.seed,
        fillStyle: parseFill(el.fill).style,
    };
}

// Shape ids are `${chartId}:…`, so each one's scoped defs ids stay unique on the page.
function layoutSvg({ shapes, labels }: ChartLayout): string {
    return shapes.map(shapeSvg).join('') + labels.map(svgTextLine).join('');
}

function shapeSvg(shape: VectorElement): string {
    const kind = SHAPE_KINDS.find((candidate) => candidate.type === shape.type);
    const body = kind ? kind.render(shape, {}).svg : '';
    return body === '' ? '' : `${elementGroupOpen(shape)}${body}</g>`;
}
