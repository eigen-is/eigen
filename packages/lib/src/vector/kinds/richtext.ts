import { backgroundCss } from '../../background';
import { getFontFamily } from '../../constants/fonts';
import { stripTagsServer } from '../../core/html';
import { isTransparentFill, parseFill } from '../fill';
import { hitTestBox, round } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import {
    CORNERS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_RICHTEXT_PROPS,
    FONT_STYLES,
    FONT_WEIGHTS,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
    type VectorRichTextElement,
} from '../types';
import { defineKind } from './kind';
import {
    clampNum,
    color,
    fillField,
    fontFamily,
    fontSize,
    htmlField,
    letterSpacingField,
    lineHeightField,
    oneOf,
} from './read-fields';
import { isBordered, isUnpainted } from './render-utils';

export const richTextKind = defineKind<VectorRichTextElement>({
    type: 'richtext',
    is: (el): el is VectorRichTextElement => el.type === 'richtext',
    // no `roughness`/`seed`: rich text is a DOM box, roughjs never touches it
    capabilities: {
        fill: true,
        fillStyle: false,
        strokeStyle: true,
        roughness: false,
        corners: true,
        edges: false,
        strokeOptional: true,
        bindable: true,
        silhouette: 'box',
        creation: 'box',
    },
    defaults: (style) => ({
        ...DEFAULT_RICHTEXT_PROPS,
        html: '',
        fill: style.fill,
        corners: style.corners,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        color: style.color,
    }),
    // The stroke is this kind's border, so a fresh box paints none until the user picks a colour.
    baseDefaults: { strokeColor: 'transparent' },
    read: (src, base) => ({
        ...base,
        type: 'richtext',
        html: htmlField(src.get('html')),
        fill: fillField(src.get('fill')),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        fontFamily: fontFamily(src.get('fontFamily')),
        fontSize: fontSize(src.get('fontSize')),
        fontWeight: oneOf(src.get('fontWeight'), FONT_WEIGHTS, DEFAULT_RICHTEXT_PROPS.fontWeight),
        fontStyle: oneOf(src.get('fontStyle'), FONT_STYLES, DEFAULT_RICHTEXT_PROPS.fontStyle),
        textDecoration: oneOf(src.get('textDecoration'), TEXT_DECORATIONS, DEFAULT_RICHTEXT_PROPS.textDecoration),
        textAlign: oneOf(src.get('textAlign'), TEXT_ALIGNS, DEFAULT_RICHTEXT_PROPS.textAlign),
        verticalAlign: oneOf(src.get('verticalAlign'), VERTICAL_ALIGNS, DEFAULT_RICHTEXT_PROPS.verticalAlign),
        color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        letterSpacing: letterSpacingField(src.get('letterSpacing')),
        lineHeight: lineHeightField(src.get('lineHeight')),
        // Bounded like the two above, so a hostile inset can't blow every peer's layout.
        padding: clampNum(src.get('padding'), 0, 200, DEFAULT_RICHTEXT_PROPS.padding),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // An empty box with no paint of its own draws literally nothing — the case the canvas rings.
    paintsNothing: (el) => isUnpainted(el) && stripTagsServer(el.html).trim() === '',
    render: (el) => ({ html: el.html, style: richTextCssText(el) }),
    // The search collector and ⌘F both read plain text; stripTagsServer is the React/DOM-free stripper
    // (core/html.ts), so this works in the API Worker as well as the browser.
    searchText: (el) => stripTagsServer(el.html).trim(),
});

// The box's paint + typography as CSS, the one body the foreignObject wrapper, the live layer renderer
// and the in-place editor share. No highlight colour on the box: a highlight is a text mark inside `html`.
export function richTextCssText(el: VectorRichTextElement): string {
    const justify =
        el.verticalAlign === 'center' ? 'center' : el.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start';
    const style = [
        'display:flex',
        'flex-direction:column',
        `justify-content:${justify}`,
        'width:100%',
        'height:100%',
        // Text wider than the stored box spills rather than being cut off (the foreignObject around it
        // is overflow="visible" for the same reason).
        'overflow:visible',
        `font-family:${getFontFamily(el.fontFamily)}`,
        `font-size:${el.fontSize}px`,
        `font-weight:${el.fontWeight}`,
        `font-style:${el.fontStyle}`,
        `text-decoration:${el.textDecoration}`,
        `text-align:${el.textAlign}`,
        `color:${el.color}`,
        `letter-spacing:${round(el.letterSpacing)}px`,
        `line-height:${round(el.lineHeight)}`,
    ];
    // The box background: the same Fill codec and the same CSS the frame/scene backgrounds speak. A
    // transparent fill is passed as "no fill" — `background-color:transparent` is a paint declaration
    // for a colour that paints nothing.
    const fill = parseFill(el.fill);
    style.push(...backgroundCss(isTransparentFill(fill) ? null : fill));
    // The stroke fields are this kind's BORDER (types.ts) — CSS border-style shares our vocabulary.
    const bordered = isBordered(el);
    if (bordered) style.push(`border:${round(el.strokeWidth)}px ${el.strokeStyle} ${el.strokeColor}`);
    const radius = cornerRadius(el, 'rectangle');
    if (radius > 0) style.push(`border-radius:${round(radius)}px`);
    if (el.padding > 0) style.push(`padding:${round(el.padding)}px`);
    // border-box once, whatever caused it: the inset and the border eat into the stored width/height
    // instead of growing the box, so the layer box and the drawn box are the same rectangle.
    if (bordered || el.padding > 0) style.push('box-sizing:border-box');
    return style.join(';');
}

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
