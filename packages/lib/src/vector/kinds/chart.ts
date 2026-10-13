import { MAX_CHART_SPEC_BYTES, parseChartSpec, sampleChartSpec } from '../../charts';
import { hitTestBox } from '../geometry';
import { rectOutline } from '../outline';
import { DEFAULT_ELEMENT_PROPS, type VectorChartElement } from '../types';
import { chartToElements } from './chart-convert';
import { renderChartSvg } from './chart-render';
import { defineKind } from './kind';
import { color, fillField, fontFamily, str } from './read-fields';

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
    defaults: (style) => ({
        chart: JSON.stringify(sampleChartSpec('column')),
        fill: style.fill,
        fontFamily: style.fontFamily,
        color: style.color,
    }),
    // The spec is kept as stored, never re-serialized: one that doesn't parse draws a placeholder and
    // stays in the doc for recovery.
    read: (src, base) => {
        const chart = str(src.get('chart'), '');
        return {
            ...base,
            type: 'chart',
            chart: new TextEncoder().encode(chart).length > MAX_CHART_SPEC_BYTES ? '' : chart,
            fill: fillField(src.get('fill')),
            fontFamily: fontFamily(src.get('fontFamily')),
            color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        };
    },
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) => rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, 0, inflate),
    render: (el) => ({ svg: renderChartSvg(el) }),
    searchText: (el) => {
        const spec = parseChartSpec(el.chart);
        if (!spec) return '';
        const { data } = spec;
        return [
            spec.title,
            spec.categoryAxis.title,
            spec.valueAxis.title,
            ...data.series.flatMap((series) => (typeof series.name === 'string' ? [series.name] : [])),
            ...(data.source === 'inline' ? data.categories : []),
        ]
            .filter((text) => text !== '')
            .join('\n');
    },
    toShapes: chartToElements,
});
