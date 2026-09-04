import { hitTestEllipse } from '../geometry';
import { ellipseOutline } from '../outline';
import type { VectorEllipseElement } from '../types';
import { defineKind } from './kind';
import { fillField, roughness, seed } from './read-fields';
import { isUnpainted, renderRoughShape } from './render-utils';

export const ellipseKind = defineKind<VectorEllipseElement>({
    type: 'ellipse',
    is: (el): el is VectorEllipseElement => el.type === 'ellipse',
    // no `corners`: an ellipse has none to treat, and a stored field nothing reads is drift
    capabilities: {
        fill: true,
        fillStyle: true,
        roughness: true,
        corners: false,
        stroke: true,
        strokeOptional: true,
        bindable: true,
        silhouette: 'ellipse',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        roughness: style.roughness,
        seed: 0, // the writer replaces it with a random one; 0 keeps `defaults` pure
    }),
    read: (src, base) => ({
        ...base,
        type: 'ellipse',
        fill: fillField(src.get('fill')),
        roughness: roughness(src.get('roughness')),
        seed: seed(src.get('seed')),
    }),
    hitTest: (el, point) => hitTestEllipse(el, point),
    outline: (el, inflate) => ellipseOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, inflate),
    // Nothing painted at all — no fill and no stroke — is invisible but real; the canvas rings it.
    paintsNothing: isUnpainted,
    render: (el) => ({ svg: renderRoughShape(el) }),
});
