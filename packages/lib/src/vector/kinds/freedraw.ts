import { getStroke } from 'perfect-freehand';
import { RoughGenerator } from 'roughjs/bin/generator';
import { isTransparentFill, parseFill } from '../fill';
import {
    distanceToPolyline,
    FREEDRAW_SIZE_FACTOR,
    getElementBounds,
    isClosedPath,
    LINEAR_HIT_SCREEN_FACTOR,
    linearLocalToScene,
    linearSceneToLocal,
    parsePoints,
    parsePressures,
    pointInPolygon,
    serializePoints,
    serializePressures,
} from '../geometry';
import { polylineOutline } from '../outline';
import {
    DEFAULT_FILL_STYLE,
    DEFAULT_LINEAR_ROUNDNESS,
    DEFAULT_SKETCH_PROPS,
    FILL_STYLES,
    ROUNDNESS,
    type VectorLinearElement,
} from '../types';
import { defineKind } from './kind';
import { bool, clampCoord, fillField, num, oneOf, str } from './read-fields';
import { drawableToSvg, escapeXml, getSvgPathFromStroke, linearRoughOptions } from './render-utils';

export const freedrawKind = defineKind<VectorLinearElement>({
    type: 'freedraw',
    is: (el): el is VectorLinearElement => el.type === 'freedraw',
    fields: ['fill', 'fillStyle', 'roughness', 'seed', 'points', 'roundness', 'pressures', 'simulatePressure'],
    capabilities: {
        fill: true,
        fillStyle: true,
        stroke: true,
        roughness: true,
        corners: false,
        opacity: true,
        typography: false,
        objectFit: false,
        arrowheads: false,
        bindable: false,
        silhouette: 'box',
        creation: 'freedraw',
        resize: 'points',
    },
    defaults: (style) => ({
        fill: style.fill,
        fillStyle: style.fillStyle,
        roughness: style.roughness,
        seed: 0, // the writer replaces it with a random one; 0 keeps `defaults` pure
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
            fillStyle: oneOf(src.get('fillStyle'), FILL_STYLES, DEFAULT_FILL_STYLE),
            roughness: num(src.get('roughness'), DEFAULT_SKETCH_PROPS.roughness),
            seed: num(src.get('seed'), DEFAULT_SKETCH_PROPS.seed),
            roundness: oneOf(src.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
            points: serializePoints(clamped),
            pressures: useReal ? serializePressures(pressures) : '',
            simulatePressure: !useReal,
        };
    },
    bounds: (el) => getElementBounds(el),
    // Unrotate the probe into the element's local frame, then measure to the polyline. Tolerance is the
    // larger of the 0.85-scaled screen threshold and the drawn ink half-width (+0.1); a closed, filled
    // path is also hit anywhere inside.
    hitTest: (el, point, threshold) => {
        const points = parsePoints(el.points);
        if (points.length === 0) return false;
        const p = linearSceneToLocal(el, point);
        const inkHalf = (el.strokeWidth * FREEDRAW_SIZE_FACTOR) / 2;
        if (distanceToPolyline(points, p) <= Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, inkHalf + 0.1)) return true;
        return isClosedPath(points) && !isTransparentFill(parseFill(el.fill)) && pointInPolygon(p, points);
    },
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
            fill = drawableToSvg(new RoughGenerator().polygon(coords, options));
        }

        // Real per-point pressure iff the element opts out of simulation AND carries an index-aligned array
        // (the reader guarantees alignment; guard here too so a hand-built element can't misfeed getStroke).
        // Absent/'' + simulate ⇒ the 2-tuple coords with simulatePressure:true — byte-identical to legacy.
        const pressures = !el.simulatePressure && el.pressures !== '' ? parsePressures(el.pressures) : [];
        const realPressure = pressures.length > 0 && pressures.length === coords.length;
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
    searchText: () => '',
});
