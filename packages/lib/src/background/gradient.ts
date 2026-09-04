// The stop list behind every gradient we paint, in one place so CSS and SVG say the same thing.
//
// Both renderers interpolate a two-stop ramp in sRGB, and so does WeasyPrint — which takes red → blue
// through a washed-out grey-purple. Sampling the ramp here in OKLab and emitting the samples as plain
// sRGB stops moves the interpolation into our code: canvas, thumbnails, previews, SVG export and PDF
// all render the same stop list, so all of them show the same perceptually even ramp.
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
type Lab = [number, number, number];

// Enough samples that the leftover per-segment sRGB error is invisible (OKLab deviates most in the
// middle, where 8 segments leave well under a just-noticeable difference), few enough that the emitted
// defs stay small.
export const GRADIENT_STOP_COUNT = 9;

// The stored gradient as sampled stops. A transparent end borrows its neighbour's colour, so an
// alpha-0 stop never drags the ramp toward black and a plain lerp is all the alpha channel needs; a
// gradient transparent at both ends paints nothing, so the colour there is arbitrary.
export function gradientStops(from: string, to: string, count: number = GRADIENT_STOP_COUNT): GradientStop[] {
    const start = parsePaint(from);
    const end = parsePaint(to);
    const fallback = start.color ?? end.color ?? '#000000';
    const startLab = toLab(start.color ?? fallback);
    const endLab = toLab(end.color ?? fallback);
    const last = Math.max(1, count - 1);
    const stops: GradientStop[] = [];
    for (let i = 0; i <= last; i++) {
        const t = i / last;
        stops.push({
            offset: round4(t),
            color: fromLab([
                lerp(startLab[0], endLab[0], t),
                lerp(startLab[1], endLab[1], t),
                lerp(startLab[2], endLab[2], t),
            ]),
            opacity: round4(lerp(start.alpha, end.alpha, t)),
        });
    }
    return stops;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
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
    const alpha = wide.length === 8 ? round4(byteAt(wide, 6) / 255) : 1;
    // A fully transparent hex says as little about the ramp's hue as the sentinel does, so it borrows
    // the other end's colour the same way — #e60076 → #00000000 fades out instead of darkening.
    return { color: alpha === 0 ? null : `#${wide.slice(0, 6).toLowerCase()}`, alpha };
}

// sRGB hex → linear-light → LMS → OKLab, as [L, a, b] (Björn Ottosson's matrices).
function toLab(color: string): Lab {
    const r = linearize(byteAt(color.slice(1), 0) / 255);
    const g = linearize(byteAt(color.slice(1), 2) / 255);
    const b = linearize(byteAt(color.slice(1), 4) / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

function fromLab([L, A, B]: Lab): string {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return `#${hex2(channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))}${hex2(channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))}${hex2(channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))}`;
}

function linearize(c: number): number {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// Linear-light back to an sRGB byte. A mix outside the gamut is clipped per channel, the way a browser
// clips a gradient it cannot represent.
function channel(c: number): number {
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, encoded * 255));
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
