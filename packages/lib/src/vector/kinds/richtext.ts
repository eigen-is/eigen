import { getFontFamily } from '../../constants/fonts';
import { stripTagsServer } from '../../core/html';
import { getElementBounds, hitTestBox } from '../geometry';
import { cornerRadius, rectOutline } from '../outline';
import {
    CORNERS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FILL_STYLE,
    DEFAULT_FONT_FAMILY,
    FILL_STYLES,
    FONT_STYLES,
    FONT_WEIGHTS,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
    type VectorRichTextElement,
} from '../types';
import { defineKind } from './kind';
import { clampNum, cleanStr, color, fillField, fontSize, htmlField, oneOf } from './read-fields';
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
    ],
    capabilities: {
        fill: true,
        fillStyle: false,
        stroke: true,
        roughness: false,
        corners: true,
        opacity: true,
        typography: true,
        objectFit: false,
        arrowheads: false,
        bindable: false,
        silhouette: 'box',
        creation: 'box',
        resize: 'box',
    },
    defaults: (style) => ({
        html: '',
        fill: style.fill,
        fillStyle: style.fillStyle,
        corners: style.corners,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        textAlign: 'left',
        verticalAlign: 'top',
        color: style.color,
        letterSpacing: 0,
        lineHeight: 1.2,
        highlightColor: 'transparent',
    }),
    read: (src, base) => ({
        ...base,
        type: 'richtext',
        html: htmlField(src.get('html')),
        fill: fillField(src.get('fill')),
        fillStyle: oneOf(src.get('fillStyle'), FILL_STYLES, DEFAULT_FILL_STYLE),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        fontFamily: cleanStr(src.get('fontFamily'), DEFAULT_FONT_FAMILY),
        fontSize: fontSize(src.get('fontSize')),
        fontWeight: oneOf(src.get('fontWeight'), FONT_WEIGHTS, 'normal'),
        fontStyle: oneOf(src.get('fontStyle'), FONT_STYLES, 'normal'),
        textDecoration: oneOf(src.get('textDecoration'), TEXT_DECORATIONS, 'none'),
        textAlign: oneOf(src.get('textAlign'), TEXT_ALIGNS, 'left'),
        verticalAlign: oneOf(src.get('verticalAlign'), VERTICAL_ALIGNS, 'top'),
        color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        highlightColor: color(src.get('highlightColor'), 'transparent'),
        // Bounded so a hostile value can't blow every peer's layout: ±200px tracking, 0.5-10x leading.
        letterSpacing: clampNum(src.get('letterSpacing'), -200, 200, 0),
        lineHeight: clampNum(src.get('lineHeight'), 0.5, 10, 1.2),
    }),
    bounds: (el) => getElementBounds(el),
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
export function richTextStyle(el: VectorRichTextElement): string {
    const justify =
        el.verticalAlign === 'center' ? 'center' : el.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start';
    return [
        'display:flex',
        'flex-direction:column',
        `justify-content:${justify}`,
        'width:100%',
        'height:100%',
        `font-family:${getFontFamily(el.fontFamily)}`,
        `font-size:${el.fontSize}px`,
        `font-weight:${el.fontWeight}`,
        `font-style:${el.fontStyle}`,
        `text-decoration:${el.textDecoration}`,
        `text-align:${el.textAlign}`,
        `color:${el.color}`,
        `letter-spacing:${round(el.letterSpacing)}px`,
        `line-height:${round(el.lineHeight)}`,
    ].join(';');
}
