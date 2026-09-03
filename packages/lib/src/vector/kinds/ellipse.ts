import { hitTestEllipse } from '../geometry';
import { ellipseOutline } from '../outline';
import { DEFAULT_FILL_STYLE, FILL_STYLES, type VectorEllipseElement } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf, roughness, seed } from './read-fields';
import { renderRoughShape } from './render-utils';

export const ellipseKind = defineKind<VectorEllipseElement>({
    type: 'ellipse',
    is: (el): el is VectorEllipseElement => el.type === 'ellipse',
    // no `corners`: an ellipse has none to treat, and a stored field nothing reads is drift
    fields: ['fill', 'fillStyle', 'roughness', 'seed'],
    capabilities: {
        fill: true,
        fillStyle: true,
        roughness: true,
        corners: false,
        bindable: true,
        silhouette: 'ellipse',
        creation: 'box',
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
        roughness: roughness(src.get('roughness')),
        seed: seed(src.get('seed')),
    }),
    hitTest: (el, point) => hitTestEllipse(el, point),
    outline: (el, inflate) => ellipseOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, inflate),
    render: (el) => ({ svg: renderRoughShape(el) }),
});
