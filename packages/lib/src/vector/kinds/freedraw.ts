import { getStroke } from 'perfect-freehand';
import { RoughGenerator } from 'roughjs/bin/generator';
import { escapeXml } from '../../core/html';
import { isTransparentFill, parseFill } from '../fill';
import {
    FREEDRAW_SIZE_FACTOR,
    hitTestLinear,
    isClosedLinear,
    isClosedPath,
    linearLocalToScene,
    parsePoints,
    parsePressures,
    serializePoints,
    serializePressures,
} from '../geometry';
import { polylineOutline } from '../outline';
import { DEFAULT_LINEAR_ROUNDNESS, ROUNDNESS, type VectorLinearElement } from '../types';
import { defineKind } from './kind';
import { bool, clampCoord, fillField, oneOf, str } from './read-fields';
import { drawableToSvg, fillDefs, getSvgPathFromStroke, linearRoughOptions } from './render-utils';

export const freedrawKind = defineKind<VectorLinearElement>({
    type: 'freedraw',
    is: (el): el is VectorLinearElement => el.type === 'freedraw',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: false,
        corners: false,
        edges: false,
        strokeOptional: false,
        bindable: false,
        creation: 'freedraw',
    },
    // An OPEN stroke paints no fill (render below), so it has none to offer.
    capabilitiesOf: (el) => ({ fill: isClosedLinear(el) }),
    defaults: (style) => ({
        fill: style.fill,
        points: '',
        roundness: DEFAULT_LINEAR_ROUNDNESS,
        pressures: '',
        simulatePressure: true,
    }),
    // A stroke without points is meaningless — skipped like an unknown type. Coords are clamped per-axis
    // (same bound as scalar spatial fields) so one corrupt peer write can't freeze others; re-serialized
    // back to the stored string form.
    read: (src, base) => {
        const points = parsePoints(str(src.get('points'), ''));
        if (points.length === 0) return null;
        const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
        // Pen pressure rides a separate index-aligned array. A stored simulate flag, a missing/garbage
        // array, or a length that drifts from the surviving points (a non-finite point was dropped) all
        // collapse to '' + simulate — so the invariant "pressures[i] pairs points[i]" holds for every
        // consumer, and legacy strokes render exactly as before.
        const pressures = parsePressures(str(src.get('pressures'), ''));
        const simulate = bool(src.get('simulatePressure'), true);
        const useReal = !simulate && pressures.length > 0 && pressures.length === clamped.length;
        return {
            ...base,
            type: 'freedraw',
            fill: fillField(src.get('fill')),
            roundness: oneOf(src.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
            points: serializePoints(clamped),
            pressures: useReal ? serializePressures(pressures) : '',
            simulatePressure: !useReal,
        };
    },
    hitTest: (el, point, threshold) => hitTestLinear(el, point, threshold, (el.strokeWidth * FREEDRAW_SIZE_FACTOR) / 2),
    outline: (el) => polylineOutline(parsePoints(el.points).map((p) => linearLocalToScene(el, p))),
    // Freehand strokes are perfect-freehand, not roughjs: a filled outline `<path>` with no stroke.
    // roughness/seed/strokeStyle don't touch the stroke; only a closed freedraw's optional fill uses them.
    render: (el) => {
        const points = parsePoints(el.points);
        const coords = points.map((p): [number, number] => [p.x, p.y]);

        // Closed + filled: the roughjs fill of the raw polygon, layered under the stroke (Excalidraw's
        // order). points-on-curve simplify isn't vendored — the raw points are the fill polygon.
        let fill = '';
        if (isClosedPath(points) && !isTransparentFill(parseFill(el.fill))) {
            const options = linearRoughOptions(el, points);
            options.stroke = 'none';
            fill = `${fillDefs(el)}${drawableToSvg(new RoughGenerator().polygon(coords, options))}`;
        }

        // Real per-point pressure iff the element opts out of simulation and carries an array — the reader
        // is what guarantees it is index-aligned with `points` ('' + simulate otherwise), so this reads the
        // pair as given. Absent/'' + simulate ⇒ the 2-tuple coords, byte-identical to legacy.
        const pressures = !el.simulatePressure && el.pressures !== '' ? parsePressures(el.pressures) : [];
        const realPressure = pressures.length === coords.length && pressures.length > 0;
        const outline = getStroke(realPressure ? coords.map(([x, y], i): number[] => [x, y, pressures[i]]) : coords, {
            simulatePressure: !realPressure,
            size: el.strokeWidth * FREEDRAW_SIZE_FACTOR,
            thinning: 0.6,
            smoothing: 0.5,
            streamline: 0.5,
            easing: (t) => Math.sin((t * Math.PI) / 2),
            last: true,
        });
        const d = getSvgPathFromStroke(outline);
        const stroke = d ? `<path d="${d}" fill="${escapeXml(el.strokeColor)}" stroke="none"/>` : '';
        return { svg: `${fill}${stroke}` };
    },
});
