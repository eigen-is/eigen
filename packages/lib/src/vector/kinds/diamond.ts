import { hitTestDiamond } from '../geometry';
import { cornerRadius, diamondOutline } from '../outline';
import { CORNERS, DEFAULT_CORNERS, type VectorDiamondElement } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf } from './read-fields';
import { isUnpainted, renderRoughShape } from './render-utils';

export const diamondKind = defineKind<VectorDiamondElement>({
    type: 'diamond',
    is: (el): el is VectorDiamondElement => el.type === 'diamond',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: true,
        edges: false,
        strokeOptional: true,
        bindable: true,
        silhouette: 'diamond',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        corners: style.corners,
    }),
    read: (src, base) => ({
        ...base,
        type: 'diamond',
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
    }),
    hitTest: (el, point) => hitTestDiamond(el, point),
    outline: (el, inflate) =>
        diamondOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'diamond'), inflate),
    paintsNothing: isUnpainted,
    render: (el) => ({ svg: renderRoughShape(el) }),
});
