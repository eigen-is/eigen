// The stop list behind every gradient we paint, in one place so CSS and SVG say the same thing.
//
// A gradient end may be the transparent sentinel, and both renderers read that as transparent BLACK:
// `#e60076 → transparent` then ramps through dark pink and paints a dirty band across the middle of
// the shape. CSS and SVG both carry opacity beside the colour, so a transparent end is emitted as the
// OTHER end's colour at opacity 0 — the ramp keeps its hue and only fades out.

import { TRANSPARENT_COLOR } from '../vector/fill';

// Opacity rides beside the colour rather than inside an #rrggbbaa, because that is the shape SVG
// wants: `stop-color` plus its own `stop-opacity` attribute.
export type GradientStop = { offset: number; color: string; opacity: number };

type Paint = { color: string | null; alpha: number };

// The two ends of a stored gradient as paint. A transparent end borrows its neighbour's colour; a
// gradient transparent at both ends paints nothing, so the colour there is arbitrary.
export function gradientStops(from: string, to: string): GradientStop[] {
    const start = parsePaint(from);
    const end = parsePaint(to);
    const fallback = start.color ?? end.color ?? '#000000';
    return [
        { offset: 0, color: start.color ?? fallback, opacity: start.alpha },
        { offset: 1, color: end.color ?? fallback, opacity: end.alpha },
    ];
}

// The CSS half of one gradient: the stop list `linear-gradient()` takes, positions in percent.
export function cssGradientStops(from: string, to: string): string {
    return gradientStops(from, to)
        .map((stop) => `${cssColor(stop)} ${stop.offset * 100}%`)
        .join(', ');
}

// The SVG half: the same stops as <stop> children of a <linearGradient>.
export function svgGradientStops(from: string, to: string): string {
    return gradientStops(from, to)
        .map(
            (stop) =>
                `<stop offset="${stop.offset}" stop-color="${stop.color}"${stop.opacity < 1 ? ` stop-opacity="${stop.opacity}"` : ''}/>`,
        )
        .join('');
}

function cssColor(stop: GradientStop): string {
    return stop.opacity < 1 ? `${stop.color}${hex2(stop.opacity * 255)}` : stop.color;
}

// #rgb / #rrggbb / #rrggbbaa / the transparent sentinel — the tokens isColorToken admits. The alpha
// is split out of the hex so both renderers get it in the channel they understand. Anything else is
// opaque black, which is what a browser does with a colour it cannot parse.
function parsePaint(token: string): Paint {
    if (token === TRANSPARENT_COLOR) return { color: null, alpha: 0 };
    const hex = token.startsWith('#') ? token.slice(1) : '';
    const wide = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    if (wide.length !== 6 && wide.length !== 8) return { color: '#000000', alpha: 1 };
    return {
        color: `#${wide.slice(0, 6).toLowerCase()}`,
        alpha: wide.length === 8 ? round4(byteAt(wide, 6) / 255) : 1,
    };
}

function byteAt(hex: string, index: number): number {
    const value = Number.parseInt(hex.slice(index, index + 2), 16);
    return Number.isNaN(value) ? 0 : value;
}

function hex2(value: number): string {
    return Math.round(value).toString(16).padStart(2, '0');
}

function round4(n: number): number {
    return Math.round(n * 10_000) / 10_000;
}
