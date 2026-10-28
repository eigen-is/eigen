// The diamond kind: a rhombus inscribed in its box, with treated corners, drawn rough, and the text it holds drawn
// over it. The text lays out in the whole box, not only inside the rhombus.

import { isUnpainted } from '../fill';
import { hitTestDiamond } from '../geometry';
import { cornerRadius, diamondOutline } from '../outline';
import type { VectorDiamondElement } from '../types';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_SHAPE_TEXT_PROPS } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';
import { plainText, readTextual, textRender, textualDefaults } from './textual';

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
        text: true,
        silhouette: 'diamond',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        corners: style.corners,
        ...textualDefaults(style, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    read: (src, base) => ({
        ...base,
        type: 'diamond',
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        ...readTextual(src, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    hitTest: (el, point) => hitTestDiamond(el, point),
    outline: (el, inflate) =>
        diamondOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'diamond'), inflate),
    paintsNothing: (el) => isUnpainted(el) && plainText(el) === '',
    render: (el) => textRender(el, renderRoughShape(el)),
    searchText: plainText,
});
