// The ellipse kind: the ellipse its box inscribes, drawn rough, and the text it holds drawn over it. The text lays
// out in the whole box, not only inside the ellipse.

import { isUnpainted } from '../fill';
import { hitTestEllipse } from '../geometry';
import { ellipseOutline } from '../outline';
import type { VectorEllipseElement } from '../types';
import { DEFAULT_SHAPE_TEXT_PROPS } from '../types';
import { defineKind } from './kind';
import { fillField } from './read-fields';
import { renderRoughShape } from './render-utils';
import { plainText, readTextual, textRender, textualDefaults } from './textual';

export const ellipseKind = defineKind<VectorEllipseElement>({
    type: 'ellipse',
    is: (el): el is VectorEllipseElement => el.type === 'ellipse',
    // no `corners`: an ellipse has none to treat, and a stored field nothing reads is drift
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: false,
        edges: false,
        strokeOptional: true,
        bindable: true,
        text: true,
        silhouette: 'ellipse',
        creation: 'box',
    },
    defaults: (style) => ({
        fill: style.fill,
        ...textualDefaults(style, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    read: (src, base) => ({
        ...base,
        type: 'ellipse',
        fill: fillField(src.get('fill')),
        ...readTextual(src, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    hitTest: (el, point) => hitTestEllipse(el, point),
    outline: (el, inflate) => ellipseOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, inflate),
    paintsNothing: (el) => isUnpainted(el) && plainText(el) === '',
    render: (el) => textRender(el, renderRoughShape(el)),
    searchText: plainText,
});
