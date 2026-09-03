import { boxCenter, getElementBounds, hitTestDiamond, type Point, rotatePoint } from '../geometry';
import { cornerRadius, diamondOutline } from '../outline';
import {
    CORNERS,
    DEFAULT_CORNERS,
    DEFAULT_FILL_STYLE,
    DEFAULT_SKETCH_PROPS,
    FILL_STYLES,
    type VectorDiamondElement,
} from '../types';
import { defineKind } from './kind';
import { fillField, num, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';

export const diamondKind = defineKind<VectorDiamondElement>({
    type: 'diamond',
    is: (el): el is VectorDiamondElement => el.type === 'diamond',
    fields: ['fill', 'fillStyle', 'corners', 'roughness', 'seed'],
    capabilities: {
        fill: true,
        fillStyle: true,
        stroke: true,
        roughness: true,
        corners: true,
        opacity: true,
        typography: false,
        objectFit: false,
        arrowheads: false,
        bindable: true,
        silhouette: 'diamond',
        creation: 'box',
        resize: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        fillStyle: style.fillStyle,
        corners: style.corners,
        roughness: style.roughness,
        seed: 0, // the writer replaces it with a random one; 0 keeps `defaults` pure
    }),
    read: (src, base) => ({
        ...base,
        type: 'diamond',
        fill: fillField(src.get('fill')),
        fillStyle: oneOf(src.get('fillStyle'), FILL_STYLES, DEFAULT_FILL_STYLE),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        roughness: num(src.get('roughness'), DEFAULT_SKETCH_PROPS.roughness),
        seed: num(src.get('seed'), DEFAULT_SKETCH_PROPS.seed),
    }),
    bounds: (el) => getElementBounds(el),
    hitTest: (el, point) => hitTestDiamond(el, point),
    outline: (el, inflate) =>
        diamondOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'diamond'), inflate),
    // A bound arrow docks on the diamond's four VERTICES (its tips — Excalidraw's getDiamondBaseCorners),
    // NOT the midpoints of its slanted edges. Same right/bottom/left/top order as the box default.
    anchorPoints: (el) => {
        const { x, y, width: w, height: h } = el;
        const center = boxCenter(el);
        return [
            { x: x + w, y: y + h / 2 },
            { x: x + w / 2, y: y + h },
            { x, y: y + h / 2 },
            { x: x + w / 2, y },
        ].map((p: Point) => rotatePoint(p, center, el.angle));
    },
    render: (el) => ({ svg: renderRoughShape(el) }),
    searchText: () => '',
});
