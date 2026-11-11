// A cell of a workbook's HTML, drawn as the canvas draws it: its style declarations, its display text, and the boxes that
// clip, turn or underlay its content. The sheet renderer calls these for each cell, and the export interns the styles
// into one stylesheet where the preview writes them inline.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { ptToPx } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import type { Cell, CellBorderSides } from '@workspace/lib/sheets';
import { borderSidesToCss, cellFontName, cellFontSize } from '@workspace/lib/sheets';
import type { CellFormatStyle, DataBar } from '@workspace/sheet/engine';
import { booleanDisplay, cellWrapsText, generalAlign, richText } from '@workspace/sheet/engine';
import { cssColorToHex, isTransparentCssColor } from '../../document/colors';
import { HORIZONTAL_ALIGN, isNumericRotation, VERTICAL_ALIGN } from './cell-style';

// Each style's declarations and the class it is interned as, since the sanitizer CSS-parses every style attribute but
// passes class names as plain strings. The preview keeps inline styles, as its body embeds without a <head>.
export type StyleRegistry = Map<string, string>;

// Every td's defaults: inline in the preview, whose embedders strip the <head>, and the shared td{} rule in the export.
export const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

// Inter's line, as a multiple of the font size. A fallback font's can be taller, and grows a default row by a few
// pixels.
const LINE_HEIGHT = 1.2;

// Where the canvas places a cell's ink: CSS places a line by its font's ascent and descent, which in Inter put the ink
// 0.1em below the middle of the line and 0.17em below its top, so the margins lift it back.
const TEXT_PLACEMENT: Record<(typeof VERTICAL_ALIGN)[number], string> = {
    top: 'top:2px;margin-top:-0.17em',
    middle: 'top:50%;transform:translateY(-50%);margin-top:-0.1em',
    bottom: 'bottom:2px',
};

// Whether a cell's content can grow its rows past their stored height, where the editor clips it. A turned span is
// placed absolutely and grows none, and a clip doubles what a cell costs WeasyPrint, so most cells stay plain.
export function canPassRows(v: Cell | null, height: number): boolean {
    if (!v || isNumericRotation(v)) return false;
    return cellWrapsText(v) || v.rt === 'vertical' || ptToPx(cellFontSize(v.fs)) * LINE_HEIGHT + 1 > height;
}

// An inline-block as tall as the rows less their gridline, as WeasyPrint pages through a block's content past its
// height but not an inline-block's. The text inside is placed absolutely, so centered text spills past both edges as
// the editor's.
export function clipToRows(
    content: string,
    height: number,
    valign: (typeof VERTICAL_ALIGN)[number],
    styles?: StyleRegistry,
): string {
    if (!content) return content;
    const clip =
        'display:inline-block;width:100%;vertical-align:top;position:relative;overflow:hidden;' +
        `text-decoration:inherit;height:${Math.max(0, height - 1)}px;margin:-1px 0`;
    const text = `position:absolute;left:0;right:0;line-height:1.1;text-decoration:inherit;${TEXT_PLACEMENT[valign]}`;
    return `<div ${styleAttr(styles, clip)}><div ${styleAttr(styles, text)}>${content}</div></div>`;
}

export function buildCellStyle(
    v: Cell | null,
    borders: CellBorderSides | undefined,
    showGrid: boolean,
    cfStyle: CellFormatStyle | undefined,
    forStylesheet: boolean,
    clipped: boolean,
): string {
    const parts: string[] = [];

    const rotated = isNumericRotation(v);

    if (v) {
        const family = cellFontName(v.ff);
        // Stylesheet text decodes no entities, so escapeHtml there would draw "Bell MT & Co" as "Bell MT &amp; Co".
        if (family) {
            const stack = getFontFamily(family);
            parts.push(`font-family:${forStylesheet ? stack : escapeHtml(stack)}`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (v.fs !== undefined) parts.push(`font-size:${cellFontSize(v.fs)}pt`);
        // A rule's colors win over the cell's own, as on the canvas.
        const textColor = cssColor(cfStyle?.textColor || v.fc);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle?.cellColor || v.bg);
        if (cellColor) parts.push(`background:${cellColor}`);
        // A rotated cell's span is placed absolutely, so no alignment acts on it. Any other writes its own or Excel's
        // General, except what the td and the table body already say: left and middle.
        if (!rotated) {
            const general = generalAlign(v);
            const ht = v.ht != null && v.ht in HORIZONTAL_ALIGN ? v.ht : general === '1' ? undefined : Number(general);
            if (ht !== undefined) parts.push(`text-align:${HORIZONTAL_ALIGN[ht]}`);
            const valign = cellVerticalAlign(v);
            if (clipped) parts.push('line-height:0');
            else if (valign !== 'middle') parts.push(`vertical-align:${valign}`);
        }
        if (cellWrapsText(v)) parts.push('white-space:pre-wrap;word-wrap:break-word');
        if (v.un === 1 && v.cl === 1) {
            parts.push('text-decoration:underline line-through');
        } else if (v.un === 1) {
            parts.push('text-decoration:underline');
        } else if (v.cl === 1) {
            parts.push('text-decoration:line-through');
        }
    } else if (cfStyle) {
        // Some rules color an empty cell too: only the rule's colors apply.
        const textColor = cssColor(cfStyle.textColor);
        if (textColor) parts.push(`color:${textColor}`);
        const cellColor = cssColor(cfStyle.cellColor);
        if (cellColor) parts.push(`background:${cellColor}`);
    }

    if (borders) {
        // CSS has no diagonal border, so the slash side `s` is not rendered.
        parts.push(...borderSidesToCss(borders, (color) => cssColor(color) ?? 'transparent'));
    } else if (showGrid) {
        parts.push('border:1px solid #d4d4d4');
    }

    // Both the data bar's layer and a rotated span are placed absolutely inside the cell.
    if (rotated || cfStyle?.dataBar) {
        parts.push('position:relative');
    }

    return parts.join(';');
}

export function cellVerticalAlign(v: Cell | null): (typeof VERTICAL_ALIGN)[number] {
    return v?.vt != null && v.vt in VERTICAL_ALIGN ? VERTICAL_ALIGN[v.vt] : 'middle';
}

// Only a string the color parser reads reaches the CSS, since a collaborator's `red;position:fixed;inset:0` would add
// declarations of its own. A bare keyword can't add one, so it passes as CSS reads it.
function cssColor(color: unknown): string | undefined {
    if (typeof color !== 'string' || !color) return undefined;
    return cssColorToHex(color) !== undefined || isTransparentCssColor(color) || /^[a-z]+$/i.test(color)
        ? color
        : undefined;
}

export function getCellDisplay(v: Cell | null): string {
    if (!v) return '';
    const rich = richText(v);
    if (rich !== undefined) return escapeHtml(rich);
    if (v.m != null) return escapeHtml(String(v.m));
    if (v.v == null) return '';
    if (typeof v.v === 'boolean') return booleanDisplay(v.v);
    return escapeHtml(String(v.v));
}

// The content turned as the canvas turns it, pinned to the corner it turns around and shifted right by sin(rt) em so it
// doesn't swing past the cell's left edge. CSS turns clockwise and rt anticlockwise, so the angle is negated.
export function wrapForRotation(v: Cell | null, inner: string, styles?: StyleRegistry): string {
    if (!v || v.rt == null) return inner;
    if (v.rt === 'vertical') {
        return `<span ${styleAttr(styles, 'writing-mode:vertical-rl;text-orientation:upright')}>${inner}</span>`;
    }
    if (isNumericRotation(v)) {
        const { rt } = v;
        const cssAngle = -rt;
        const yPin = rt > 0 ? 'bottom:0' : 'top:0';
        const origin = rt > 0 ? 'left bottom' : 'left top';
        const overhangEm = Math.abs(Math.sin((rt * Math.PI) / 180)).toFixed(3);
        const decl =
            `position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;text-decoration:inherit;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)`;
        return `<span ${styleAttr(styles, decl)}>${inner}</span>`;
    }
    return inner;
}

// The data bar as the canvas paints it: a negative value left of the zero line, always red, a positive one right of it.
export function renderDataBar(bar: DataBar, display: string, styles?: StyleRegistry): string {
    const from = cssColor(bar.format[0]) ?? 'transparent';
    const to = cssColor(bar.format[1]) ?? 'transparent';
    let left: number;
    let width: number;
    let fill: string;
    if (bar.valueType === 'minus') {
        left = bar.minusLen * (1 - bar.valueLen) * 100;
        width = bar.minusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? 'linear-gradient(to right, #ffffff, #ff0000)' : '#ff0000';
    } else if (bar.plusLen === 1) {
        left = 0;
        width = bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    } else {
        // A positive value in a range with negatives starts at the zero line.
        left = bar.minusLen * 100;
        width = bar.plusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    }

    const barStyle = `position:absolute;top:0;left:${left}%;width:${width}%;height:100%;background:${fill};z-index:0`;
    const textStyle = 'position:relative;z-index:1;text-decoration:inherit';
    return `<div ${styleAttr(styles, barStyle)}></div><span ${styleAttr(styles, textStyle)}>${display}</span>`;
}

export function styleAttr(styles: StyleRegistry | undefined, declarations: string): string {
    return styles ? `class="${internStyle(styles, declarations)}"` : `style="${declarations}"`;
}

export function internStyle(styles: StyleRegistry, declarations: string): string {
    let cls = styles.get(declarations);
    if (cls === undefined) {
        cls = `s${styles.size}`;
        styles.set(declarations, cls);
    }
    return cls;
}

// What is structural in CSS text and in no real declaration: `<` and `>` end the element, `{` and `}` open a rule, `\`
// spells `url(` past the sanitizer's scan, and `/*` swallows later rules. Every declaration passes here.
const CSS_TEXT_STRUCTURAL = /[<>{}\\]|\/\*|\*\//g;

export function serializeStyleRules(styles: StyleRegistry): string {
    const rules = [`td{${BASE_TD_STYLE}}`];
    for (const [declarations, cls] of styles) {
        rules.push(`.${cls}{${declarations.replace(CSS_TEXT_STRUCTURAL, '')}}`);
    }
    return rules.join('\n');
}
