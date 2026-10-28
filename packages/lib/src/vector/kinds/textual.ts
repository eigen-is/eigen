// The text a kind holds, such as a text box's or a rectangle's: one implementation that every kind with text
// composes. It gives a new element its text fields, reads and clamps the stored ones, turns the typography into
// CSS and chooses the render arm. It imports only leaf modules, never geometry or a kind, so the chart's shape
// builders can use it without loading the kind registry.

import { getFontFamily } from '../../constants/fonts';
import { stripTagsServer } from '../../core/html';
import { isBordered } from '../fill';
import { round } from '../points';
import type { TextProps, Textual, VectorElementBase } from '../types';
import {
    DEFAULT_ELEMENT_PROPS,
    FONT_STYLES,
    FONT_WEIGHTS,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
} from '../types';
import type { RenderOutput, StyleDefaults } from './kind';
import type { YMapLike } from './read-fields';
import {
    clampNum,
    color,
    fontFamily,
    fontSize,
    htmlField,
    letterSpacingField,
    lineHeightField,
    oneOf,
} from './read-fields';

type TextElement = VectorElementBase & Textual;

// A new element's text: none yet, in the host's font, size and color, with the kind's typography.
export function textualDefaults(
    style: Pick<StyleDefaults, 'fontFamily' | 'fontSize' | 'color'>,
    props: TextProps,
): Textual {
    return { ...props, html: '', fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color };
}

// The stored text fields, each validated. A missing or corrupt one reads as the kind's props, so a shape stored
// before shapes held text reads centered, and a text box top left.
export function readTextual(src: YMapLike, props: TextProps): Textual {
    return {
        html: htmlField(src.get('html')),
        fontFamily: fontFamily(src.get('fontFamily')),
        fontSize: fontSize(src.get('fontSize')),
        fontWeight: oneOf(src.get('fontWeight'), FONT_WEIGHTS, props.fontWeight),
        fontStyle: oneOf(src.get('fontStyle'), FONT_STYLES, props.fontStyle),
        textDecoration: oneOf(src.get('textDecoration'), TEXT_DECORATIONS, props.textDecoration),
        textAlign: oneOf(src.get('textAlign'), TEXT_ALIGNS, props.textAlign),
        verticalAlign: oneOf(src.get('verticalAlign'), VERTICAL_ALIGNS, props.verticalAlign),
        color: color(src.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
        letterSpacing: letterSpacingField(src.get('letterSpacing')),
        lineHeight: lineHeightField(src.get('lineHeight')),
        // Bounded like the two above, so a hostile inset can't blow every peer's layout.
        padding: clampNum(src.get('padding'), 0, 200, props.padding),
    };
}

// The text's TYPOGRAPHY as CSS, the one body the foreignObject wrapper, the live layer renderer and the
// in-place editor share; the element's paint is the roughjs drawing behind it. No highlight color: a
// highlight is a text mark inside `html`.
export function richTextCssText(el: TextElement): string {
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
    // The drawn border sits ON the box edge, so the text clears it as well as the user's inset; border-box
    // keeps both inside the stored width/height, so the layer box and the drawn box are one rectangle.
    const inset = el.padding + (isBordered(el) ? el.strokeWidth : 0);
    if (inset > 0) style.push(`padding:${round(inset)}px`, 'box-sizing:border-box');
    return style.join(';');
}

// A shape's render: its own svg alone while it holds no text, so it draws the bytes it drew before shapes held
// text, and the text over that svg once it does.
export function textRender(el: TextElement, svg: string): RenderOutput {
    return el.html === '' ? { svg } : { html: el.html, style: richTextCssText(el), svg };
}

// The text without its markup, which search reads and which decides whether an unpainted element shows anything.
// stripTagsServer needs no DOM, so this runs on the server too.
export function plainText(el: Textual): string {
    return stripTagsServer(el.html).trim();
}
