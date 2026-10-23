// A rich-text box's text as real SVG <text>, from the browser's own layout of the box: one positioned <tspan> per
// run of characters laid out side by side on one baseline. The canvas's <foreignObject> is HTML only a browser
// draws, so a downloaded image writes this instead, which Illustrator, Inkscape, Figma, Office and Preview read.
// The measuring is DOM work (packages/ui's canvas image writer reads Range.getClientRects); this half is pure.

import { escapeXml } from '../core/xml';
import { round } from './geometry';

export type MeasuredTextStyle = {
    // The computed CSS family list, written as it is.
    fontFamily: string;
    fontSize: number;
    fontWeight: string;
    fontStyle: string;
    fontVariantNumeric: string;
    // A computed CSS colour, rgb() or rgba().
    color: string;
    // Its ancestors' opacity inside the box, multiplied.
    opacity: number;
    // The decoration lines drawn on it, its own and those its ancestors propagate: '' or e.g. 'underline'.
    decoration: string;
    letterSpacing: number;
};

// One character's box, as Range.getClientRects reports it, in the box's local frame.
export type MeasuredChar = { text: string; x: number; y: number; width: number; height: number };

// One text node: its characters in reading order, a collapsed one left out, and how far below a character box's top
// its baseline sits.
export type MeasuredText = { style: MeasuredTextStyle; ascent: number; chars: MeasuredChar[] };

// A border the text draws beside it: a quote's rule.
export type MeasuredRule = { x: number; y: number; width: number; height: number; color: string; opacity: number };

// A bulleted item's disc: where the item starts, its first line's baseline and its font's ascent.
export type MeasuredDisc = { x: number; baseline: number; ascent: number; color: string; opacity: number };

// A justified line stretches its spaces, which no SVG reader repeats, so each of its words is placed on its own.
export type MeasuredRichText = {
    texts: MeasuredText[];
    rules: MeasuredRule[];
    discs: MeasuredDisc[];
    justify: boolean;
};

type Placed = { char: MeasuredChar; text: number };

// Within a pixel is where the browser puts the next character of a run; anything else is a wrap, a marker or a gap.
function adjoins(a: MeasuredChar, b: MeasuredChar): boolean {
    return Math.abs(b.x - (a.x + a.width)) <= 0.5 && b.y < a.y + a.height && a.y < b.y + b.height;
}

// An SVG 1.1 reader takes no rgba(), so the alpha rides in fill-opacity with the rest of the opacity.
function fillAttrs(color: string, opacity: number): string {
    const match = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    const fill = match
        ? `#${match
              .slice(1, 4)
              .map((channel) => Math.round(Number(channel)).toString(16).padStart(2, '0'))
              .join('')}`
        : color;
    const alpha = (match?.[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1)) * opacity;
    return ` fill="${escapeXml(fill)}"${alpha < 1 ? ` fill-opacity="${round(alpha)}"` : ''}`;
}

function tspan(chars: MeasuredChar[], { style, ascent }: MeasuredText): string {
    const text = chars.map((ch) => ch.text.replace(/[\t\n\r]/g, ' ')).join('');
    let attrs = ` font-family="${escapeXml(style.fontFamily)}" font-size="${round(style.fontSize)}px"`;
    if (style.fontWeight !== '400' && style.fontWeight !== 'normal') attrs += ` font-weight="${style.fontWeight}"`;
    if (style.fontStyle !== 'normal') attrs += ` font-style="${escapeXml(style.fontStyle)}"`;
    attrs += fillAttrs(style.color, style.opacity);
    if (style.decoration !== '') attrs += ` text-decoration="${escapeXml(style.decoration)}"`;
    if (style.letterSpacing !== 0) attrs += ` letter-spacing="${round(style.letterSpacing)}"`;
    if (style.fontVariantNumeric !== 'normal') {
        attrs += ` style="font-variant-numeric:${escapeXml(style.fontVariantNumeric)}"`;
    }
    return `<tspan x="${round(chars[0].x)}" y="${round(chars[0].y + ascent)}"${attrs}>${escapeXml(text)}</tspan>`;
}

// Chrome paints a disc as a circle of its own, not the bullet glyph, in whole pixels from the rounded ascent
// (Blink's ListMarker symbol rect): two thirds of it, halved, across, that two thirds and 7 px before the item, and
// half again the rest of the ascent below the text's top. No DOM reaches a marker's paint, so this restates it.
function disc({ x, baseline, ascent, color, opacity }: MeasuredDisc): string {
    const rounded = Math.round(ascent);
    const twoThirds = Math.floor((rounded * 2) / 3);
    const r = Math.floor((twoThirds + 1) / 2) / 2;
    const left = x - twoThirds - 7;
    const top = baseline - rounded + Math.floor((3 * (rounded - twoThirds)) / 2);
    return `<circle cx="${round(left + r)}" cy="${round(top + r)}" r="${round(r)}"${fillAttrs(color, opacity)}/>`;
}

export function richTextSvg({ texts, rules, discs, justify }: MeasuredRichText): string {
    const placed: Placed[] = texts.flatMap((measured, text) => measured.chars.map((char) => ({ char, text })));
    let spans = '';
    let start = 0;
    for (let i = 1; i <= placed.length; i++) {
        const prev = placed[i - 1];
        const next = placed[i];
        const runs =
            next !== undefined &&
            next.text === prev.text &&
            adjoins(prev.char, next.char) &&
            !(justify && prev.char.text === ' ');
        if (runs) continue;
        let first = start;
        let last = i - 1;
        // The space a line starts or ends on draws nothing, and an underline under it would.
        if (first === 0 || !adjoins(placed[first - 1].char, placed[first].char)) {
            while (first <= last && placed[first].char.text === ' ') first++;
        }
        if (next === undefined || !adjoins(prev.char, next.char)) {
            while (last >= first && placed[last].char.text === ' ') last--;
        }
        if (first <= last) {
            spans += tspan(
                placed.slice(first, last + 1).map((p) => p.char),
                texts[prev.text],
            );
        }
        start = i;
    }
    const drawn =
        rules
            .map(
                (rule) =>
                    `<rect x="${round(rule.x)}" y="${round(rule.y)}" width="${round(rule.width)}" height="${round(rule.height)}"${fillAttrs(rule.color, rule.opacity)}/>`,
            )
            .join('') + discs.map(disc).join('');
    if (spans === '') return drawn;
    return `${drawn}<text xml:space="preserve" style="white-space:pre">${spans}</text>`;
}
