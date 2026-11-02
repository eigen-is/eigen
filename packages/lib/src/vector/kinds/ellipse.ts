// The ellipse kind: the ellipse its box inscribes, drawn rough, and the text it holds drawn over it. The text lays
// out in the whole box, not only inside the ellipse.

import { isUnpainted } from '../fill';
import { hitTestEllipse } from '../geometry';
import { ellipseOutline } from '../outline';
import type { VectorEllipseElement } from '../types';
import { DEFAULT_SHAPE_TEXT_PROPS } from '../types';
import { BOX_CAPABILITIES, defineKind, readBoxShape } from './kind';
import { renderRoughShape } from './render-utils';
import { hasText, plainText, textRender, textualDefaults } from './textual';

export const ellipseKind = defineKind<VectorEllipseElement>({
    type: 'ellipse',
    is: (el): el is VectorEllipseElement => el.type === 'ellipse',
    // An ellipse has no corners to treat, so it neither offers the row nor stores the field.
    capabilities: { ...BOX_CAPABILITIES, corners: false, silhouette: 'ellipse' },
    defaults: (style) => ({
        fill: style.fill,
        ...textualDefaults(style, DEFAULT_SHAPE_TEXT_PROPS),
    }),
    read: (src, base) => ({
        ...base,
        type: 'ellipse',
        ...readBoxShape(src),
    }),
    hitTest: (el, point) => hitTestEllipse(el, point),
    outline: (el, inflate) => ellipseOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, inflate),
    paintsNothing: (el) => isUnpainted(el) && !hasText(el),
    render: (el) => textRender(el, renderRoughShape(el)),
    searchText: plainText,
});
