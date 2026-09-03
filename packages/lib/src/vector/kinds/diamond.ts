import { hitTestDiamond } from '../geometry';
import { cornerRadius, diamondOutline } from '../outline';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_FILL_STYLE, FILL_STYLES, type VectorDiamondElement } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf, roughness, seed } from './read-fields';
import { renderRoughShape } from './render-utils';

export const diamondKind = defineKind<VectorDiamondElement>({
    type: 'diamond',
    is: (el): el is VectorDiamondElement => el.type === 'diamond',
    fields: ['fill', 'fillStyle', 'corners', 'roughness', 'seed'],
    capabilities: {
        fill: true,
        fillStyle: true,
        roughness: true,
        corners: true,
        stroke: true,
        strokeOptional: true,
        typography: false,
        objectFit: false,
        bindable: true,
        silhouette: 'diamond',
        creation: 'box',
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
        roughness: roughness(src.get('roughness')),
        seed: seed(src.get('seed')),
    }),
    hitTest: (el, point) => hitTestDiamond(el, point),
    outline: (el, inflate) =>
        diamondOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'diamond'), inflate),
    render: (el) => ({ svg: renderRoughShape(el) }),
});
