// The chart kind: one chart's spec stored on the element as a JSON string per part, drawn as the canvas's own shapes
// plus SVG text. Its look is the element's paint fields; the panel section and Edit data are the ui kind's.

import {
    chartSearchText,
    chartSpecTexts,
    isChartSpecPartKey,
    mapChartSpecParts,
    newChartSpecParts,
    readChartSpec,
    sampleChartSpec,
} from '../../charts';
import { CHART_SPEC_PART_KEY } from '../../types/chart';
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
    // doc for recovery, and a newer build's part is kept on the element too. Past the byte limit, summed over every
    // part, the read stops: each part reads as '' and no newer part is kept.
    read: (src, base) => {
        const texts = chartSpecTexts(src) ?? {};
        return {
            ...base,
            ...Object.fromEntries(Object.entries(texts).filter(([key]) => !isChartSpecPartKey(key))),
            type: 'chart',
            ...mapChartSpecParts((part) => texts[CHART_SPEC_PART_KEY[part]] ?? ''),
            fill: fillField(src.get('fill')),
            color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
            seriesStrokeWidth: optionalStrokeWidth(src.get('seriesStrokeWidth')),
        };
    },
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) => rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, 0, inflate),
    render: (el) => ({ svg: renderChartSvg(el) }),
    searchText: (el) => chartSearchText(readChartSpec(el).spec),
    // The font its labels draw in; the placeholder adds none.
    fontFamilies: (el) => chartElementLayout(el)?.labels.map((label) => label.fontFamily) ?? [],
    toShapes: chartToElements,
});
