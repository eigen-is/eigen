// The chart's drawing body: the layout's shapes, each drawn by its own kind in its own group, then the
// labels as SVG text. Split from the kind like arrow-render.ts. The kinds are imported one by one, never
// through the registry, which imports the chart kind.

import { CHART_MESSAGES, formatTickValue, layoutChart, layoutChartMessage, parseChartSpec } from '../../charts';
import type { ChartLayout, ChartLayoutInput, ChartShape } from '../../types/chart';
import { parseFill } from '../fill';
import { round } from '../geometry';
import type { VectorChartElement } from '../types';
import { ellipseKind } from './ellipse';
import type { ElementKind } from './kind';
import { lineKind } from './line';
import { pieKind } from './pie';
import { rectangleKind } from './rectangle';
import { elementGroupOpen, PLACEHOLDER_STROKE, svgTextLine } from './render-utils';

const SHAPE_KINDS: Record<ChartShape['type'], ElementKind> = {
    rectangle: rectangleKind,
    line: lineKind,
    ellipse: ellipseKind,
    pie: pieKind,
};

export function renderChartSvg(el: VectorChartElement): string {
    const layout = chartLayout(el);
    if (layout) return layoutSvg(layout);
    const outline = `<rect x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" ${PLACEHOLDER_STROKE}/>`;
    return outline + layoutSvg(layoutChartMessage(chartBox(el), CHART_MESSAGES.unreadable));
}

// What the chart draws, which Convert to shapes unpacks too; null for the placeholder. A canvas has no sheet
// to read range data from; a malformed spec stays stored for recovery.
export function chartLayout(el: VectorChartElement): ChartLayout | null {
    const spec = parseChartSpec(el.chart);
    if (spec === null || spec.data.source !== 'inline') return null;
    return layoutChart({ ...chartBox(el), spec, data: spec.data, formatTick: formatTickValue });
}

// The fill's paint is the background and its hatch style the marks'; the stroke draws axes and gridlines.
function chartBox(el: VectorChartElement): Pick<ChartLayoutInput, 'id' | 'width' | 'height' | 'paint'> {
    return {
        id: el.id,
        width: el.width,
        height: el.height,
        paint: {
            fontFamily: el.fontFamily,
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
