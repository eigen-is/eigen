import { getFontFamily } from '../../constants/fonts';
import { stripTagsServer } from '../../core/html';
import { hitTestBox } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import {
    CORNERS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FILL_STYLE,
    DEFAULT_RICHTEXT_PROPS,
    FILL_STYLES,
    FONT_STYLES,
    FONT_WEIGHTS,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
    type VectorRichTextElement,
} from '../types';
import { defineKind } from './kind';
import { clampNum, color, fillField, fontFamily, fontSize, htmlField, oneOf } from './read-fields';
import { round } from './render-utils';

export const richTextKind = defineKind<VectorRichTextElement>({
    type: 'richtext',
    is: (el): el is VectorRichTextElement => el.type === 'richtext',
    // no `roughness`/`seed`: rich text is a DOM box, roughjs never touches it
    fields: [
        'html',
        'fill',
        'fillStyle',
        'corners',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'textDecoration',
        'textAlign',
        'verticalAlign',
        'color',
        'letterSpacing',
        'lineHeight',
        'highlightColor',
        'padding',
    ],
    capabilities: {
        fill: true,
        fillStyle: false,
        roughness: false,
        corners: true,
        bindable: false,
        silhouette: 'box',
        creation: 'box',
    },
    defaults: (style) => ({
        ...DEFAULT_RICHTEXT_PROPS,
        html: '',
        fill: style.fill,
        fillStyle: style.fillStyle,
        corners: style.corners,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        color: style.color,
    }),
    read: (src, base) => ({
        ...base,
        type: 'richtext',
        html: htmlField(src.get('html')),
        fill: fillField(src.get('fill')),
        fillStyle: oneOf(src.get('fillStyle'), FILL_STYLES, DEFAULT_FILL_STYLE),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        fontFamily: fontFamily(src.get('fontFamily')),
        fontSize: fontSize(src.get('fontSize')),
        fontWeight: oneOf(src.get('fontWeight'), FONT_WEIGHTS, DEFAULT_RICHTEXT_PROPS.fontWeight),
        fontStyle: oneOf(src.get('fontStyle'), FONT_STYLES, DEFAULT_RICHTEXT_PROPS.fontStyle),
        textDecoration: oneOf(src.get('textDecoration'), TEXT_DECORATIONS, DEFAULT_RICHTEXT_PROPS.textDecoration),
        textAlign: oneOf(src.get('textAlign'), TEXT_ALIGNS, DEFAULT_RICHTEXT_PROPS.textAlign),
        verticalAlign: oneOf(src.get('verticalAlign'), VERTICAL_ALIGNS, DEFAULT_RICHTEXT_PROPS.verticalAlign),
        color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        highlightColor: color(src.get('highlightColor'), DEFAULT_RICHTEXT_PROPS.highlightColor),
        // Bounded so a hostile value can't blow every peer's layout: ±200px tracking, 0.5-10x leading,
        // 0-200px inset.
        letterSpacing: clampNum(src.get('letterSpacing'), -200, 200, DEFAULT_RICHTEXT_PROPS.letterSpacing),
        lineHeight: clampNum(src.get('lineHeight'), 0.5, 10, DEFAULT_RICHTEXT_PROPS.lineHeight),
        padding: clampNum(src.get('padding'), 0, 200, DEFAULT_RICHTEXT_PROPS.padding),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    render: (el) => ({ html: el.html, style: richTextStyle(el) }),
    // The search collector and ⌘F both read plain text; stripTagsServer is the React/DOM-free stripper
    // (core/html.ts), so this works in the API Worker as well as the browser.
    searchText: (el) => stripTagsServer(el.html).trim(),
});

// The box's typography as CSS, the one body the foreignObject wrapper and the live layer renderer share.
// `highlightColor` is deliberately absent: it is a text mark applied inside `html`, and painting it on the
// box is what gave slides its full-width highlight bug.
function richTextStyle(el: VectorRichTextElement): string {
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
    // border-box so the inset eats into the stored width/height instead of growing the box. Both
    // declarations are omitted at padding 0, so an unpadded box's style string is unchanged.
    if (el.padding > 0) style.push(`padding:${round(el.padding)}px`, 'box-sizing:border-box');
    return style.join(';');
}
