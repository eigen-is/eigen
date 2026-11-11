// The chart kind: one chart's spec stored on the element as a JSON string per part, drawn as the canvas's own shapes
// plus SVG text. Its look is the element's paint fields; the panel section and Edit data are the ui kind's.

import { chartSearchText, chartSpecTexts, newChartSpecParts, readChartSpec, sampleChartSpec } from '../../charts';
import { hitTestBox } from '../geometry';
import { rectOutline } from '../outline';
import type { VectorChartElement } from '../types';
import { DEFAULT_ELEMENT_PROPS } from '../types';
import { chartToElements } from './chart-convert';
import { chartElementLayout, renderChartSvg } from './chart-render';
import { defineKind } from './kind';
import { color, fillField, optionalStrokeWidth } from './read-fields';

export const chartKind = defineKind<VectorChartElement>({
    type: 'chart',
    is: (el): el is VectorChartElement => el.type === 'chart',
    // fillStyle: the fill's hatch style is the bars' and slices'. The stroke draws the axes and gridlines.
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: false,
        edges: false,
        strokeOptional: true,
        bindable: true,
        text: false,
        silhouette: 'box',
        creation: 'none',
    },
    // The host's font goes into the spec, which every label reads it from. A new chart's line series draw at its
    // stroke, so it has no series width. The key is listed without a value so the element stores the width an Office
    // import sets.
    defaults: (style) => ({
        ...newChartSpecParts(sampleChartSpec('column', style.fontFamily)),
        fill: style.fill,
        color: style.color,
        seriesStrokeWidth: undefined,
    }),
    // Each part is kept as stored, never re-serialized: one that doesn't parse draws a placeholder and stays in the
    // doc for recovery. Past the byte limit, summed over the parts, each reads as ''.
    read: (src, base) => ({
        ...base,
        type: 'chart',
        ...newChartSpecParts(chartSpecTexts(src) ?? {}),
        fill: fillField(src.get('fill')),
        color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        seriesStrokeWidth: optionalStrokeWidth(src.get('seriesStrokeWidth')),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) => rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, 0, inflate),
    render: (el) => ({ svg: renderChartSvg(el) }),
    searchText: (el) => chartSearchText(readChartSpec(el).spec),
    // Its labels, in the font they draw in; the placeholder adds none.
    fontRuns: (el) =>
        chartElementLayout(el)?.labels.map(({ fontFamily, text }) => ({ family: fontFamily, text })) ?? [],
    toShapes: chartToElements,
});
