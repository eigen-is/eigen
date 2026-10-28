// The rich-text kind: a box of HTML text with its typography, drawn as a foreignObject over a rough backdrop. A box
// grows to fit its text and never shrinks by itself, so the stored height is its minimum.

import { isBordered, isUnpainted } from '../fill';
import { hitTestBox } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import type { VectorRichTextElement } from '../types';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_RICHTEXT_PROPS } from '../types';
import { defineKind } from './kind';
import { fillField, oneOf } from './read-fields';
import { renderRoughShape } from './render-utils';
import { plainText, readTextual, richTextCssText, textualDefaults } from './textual';

export const richTextKind = defineKind<VectorRichTextElement>({
    type: 'richtext',
    is: (el): el is VectorRichTextElement => el.type === 'richtext',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: true,
        edges: false,
        strokeOptional: true,
        bindable: true,
        text: true,
        silhouette: 'box',
        creation: 'box',
    },
    defaults: (style) => ({
        ...textualDefaults(style, DEFAULT_RICHTEXT_PROPS),
        fill: style.fill,
        corners: style.corners,
    }),
    // The stroke is this kind's border, so a fresh box paints none until the user picks a color.
    baseDefaults: { strokeColor: 'transparent' },
    read: (src, base) => ({
        ...base,
        type: 'richtext',
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        ...readTextual(src, DEFAULT_RICHTEXT_PROPS),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // An empty box with no paint of its own draws literally nothing — the case the canvas rings.
    paintsNothing: (el) => isUnpainted(el) && plainText(el) === '',
    render: (el) => ({ html: el.html, style: richTextCssText(el), svg: isUnpainted(el) ? '' : renderRoughShape(el) }),
    searchText: plainText,
});

// A box's height GROWS with the text in it: whatever renders it measures its body and writes the fit
// back when the text needs more room than the box has. The stored height is the user's MINIMUM, never
// a maximum — extra height is how a box is vertically aligned (`verticalAlign` has nothing to work
// with otherwise), so nothing ever shrinks a box automatically; a manual resize sets the new minimum.
// `contentHeight` is the body's own extent; the stored height is the border box, so the inset and the
// border ride inside it. null = the box is already tall enough, which is also the loop guard: every
// peer measures the same box, and only a real (>= 1px) shortfall is ever written.
export function richTextFitHeight(el: VectorRichTextElement, contentHeight: number): number | null {
    const needed = contentHeight + 2 * el.padding + (isBordered(el) ? 2 * el.strokeWidth : 0);
    // A sub-pixel shortfall is left alone: the body overflows visibly rather than clipping, so writing
    // for it would only cost every peer a round of updates.
    return needed - el.height >= 1 ? Math.ceil(needed) : null;
}
