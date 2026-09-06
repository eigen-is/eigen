import { RoughGenerator } from 'roughjs/bin/generator';
import { hitTestLinear, isClosedLinear, linearLocalToScene, parsePoints, serializePoints } from '../geometry';
import { polylineOutline } from '../outline';
import { DEFAULT_LINE_ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS, ROUNDNESS, type VectorLinearElement } from '../types';
import { defineKind } from './kind';
import { clampCoord, fillField, oneOf, str } from './read-fields';
import { drawableToSvg, fillDefs, linearRoughOptions } from './render-utils';

export const lineKind = defineKind<VectorLinearElement>({
    type: 'line',
    is: (el): el is VectorLinearElement => el.type === 'line',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: false,
        edges: true,
        strokeOptional: false,
        bindable: false,
        creation: 'polyline',
    },
    // An OPEN polyline paints no fill (linearRoughOptions), so it has none to offer.
    capabilitiesOf: (el) => ({ fill: isClosedLinear(el) }),
    defaults: (style) => ({
        fill: style.fill,
        points: '',
        roundness: DEFAULT_LINE_ROUNDNESS,
        // `pressures`/`simulatePressure` are the linear family's, and a line stores the "no pressure" pair
        // ('' + simulate) the reader forces on it — freedraw is the only kind that varies them.
        pressures: '',
        simulatePressure: true,
    }),
    read: (src, base) => {
        const points = parsePoints(str(src.get('points'), ''));
        if (points.length === 0) return null;
        const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
        return {
            ...base,
            type: 'line',
            fill: fillField(src.get('fill')),
            roundness: oneOf(src.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
            points: serializePoints(clamped),
            pressures: '',
            simulatePressure: true,
        };
    },
    hitTest: (el, point, threshold) => hitTestLinear(el, point, threshold, el.strokeWidth / 2),
    outline: (el) => polylineOutline(parsePoints(el.points).map((p) => linearLocalToScene(el, p))),
    // Lines are roughjs: Excalidraw's line arm — rounded curves through the vertices, sharp linearPaths,
    // and (only when the path loops) a filled polygon/curve.
    render: (el) => {
        const gen = new RoughGenerator();
        const points = parsePoints(el.points);
        const coords = points.map((p): [number, number] => [p.x, p.y]);
        const options = linearRoughOptions(el, points);
        const drawable =
            el.roundness === 'round'
                ? gen.curve(coords, options)
                : options.fill
                  ? gen.polygon(coords, options)
                  : gen.linearPath(coords, options);
        // A gradient's defs ride along only when the path actually loops and fills.
        const defs = options.fill === undefined ? '' : fillDefs(el);
        return { svg: `${defs}<g stroke-linecap="round">${drawableToSvg(drawable)}</g>` };
    },
});
