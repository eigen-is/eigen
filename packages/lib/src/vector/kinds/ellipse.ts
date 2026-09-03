import { getElementBounds, hitTestEllipse } from '../geometry';
import { ellipseOutline } from '../outline';
import { DEFAULT_FILL_STYLE, DEFAULT_SKETCH_PROPS, FILL_STYLES, type VectorEllipseElement } from '../types';
import { defineKind } from './kind';
import { fillField, num, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';

export const ellipseKind = defineKind<VectorEllipseElement>({
    type: 'ellipse',
    is: (el): el is VectorEllipseElement => el.type === 'ellipse',
    // no `corners`: an ellipse has none to treat, and a stored field nothing reads is drift
    fields: ['fill', 'fillStyle', 'roughness', 'seed'],
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
        bindable: true,
        creation: 'box',
        resize: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        fillStyle: style.fillStyle,
        roughness: style.roughness,
        seed: 0, // the writer replaces it with a random one; 0 keeps `defaults` pure
    }),
    read: (src, base) => ({
        ...base,
        type: 'ellipse',
        fill: fillField(src.get('fill')),
        fillStyle: oneOf(src.get('fillStyle'), FILL_STYLES, DEFAULT_FILL_STYLE),
        roughness: num(src.get('roughness'), DEFAULT_SKETCH_PROPS.roughness),
        seed: num(src.get('seed'), DEFAULT_SKETCH_PROPS.seed),
    }),
    bounds: (el) => getElementBounds(el),
    hitTest: (el, point) => hitTestEllipse(el, point),
    outline: (el, inflate) => ellipseOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, inflate),
    render: (el) => ({ svg: renderRoughShape(el) }),
    searchText: () => '',
});
