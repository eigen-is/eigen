// The stored-fill codec. An element's `fill` is a JSON scalar like `points` — one string field, so the
// scalar-only ELEMENT_FIELDS convention holds — and a frame's `background` is the same codec widened to
// the image variant. Strict: '' or anything malformed reads back as the transparent solid fill, so a
// corrupt peer write can never throw on a render path. Beside it sit the predicates that ask whether an
// element's fill and stroke paint at all, which a kind's renderer and text inset both read.

import { isHexColor } from '../constants/colors';
import type { BackgroundFill, Fill, FillPaint } from '../types/background';
import { isSafeMediaName } from './media-refs';
import { normalizeAngle, round4 } from './outline';
import type { FillStyle } from './types';
import { DEFAULT_FILL_STYLE, FILL_STYLES, prop } from './types';

// "Paint nothing" as a bare color: a fill with no paint, a scene with no background, a shape or box
// whose border is switched off. One token, so the predicate and every writer agree on the spelling.
export const TRANSPARENT_COLOR = 'transparent';

export const TRANSPARENT_FILL: Fill = { type: 'solid', color: TRANSPARENT_COLOR, style: DEFAULT_FILL_STYLE };

// Colors come from the ColorPicker: hex (#rgb/#rrggbb/#rrggbbaa) or the 'transparent' sentinel.
// Anything else is rejected; this closes `url(...)` paint-server smuggling into export.
export function isColorToken(v: unknown): v is string {
    return typeof v === 'string' && (v === TRANSPARENT_COLOR || isHexColor(v, [3, 6, 8]));
}

// The scene background, an element's fill and a switched-off border all answer through this predicate.
export function isTransparentColor(color: string): boolean {
    return color === TRANSPARENT_COLOR;
}

export function isTransparentFill(fill: Fill): boolean {
    return fill.type === 'solid' && isTransparentColor(fill.color);
}

// Whether the stroke paints at all. The DOM-box kinds (image, rich text) use it as a border, and a shape's text
// is inset past it, so "does this one paint a border" is one predicate, not a repeated pair of tests.
export function isBordered(el: { strokeWidth: number; strokeColor: string }): boolean {
    return el.strokeWidth > 0 && !isTransparentColor(el.strokeColor);
}

// Neither a painted fill nor a painted stroke: the element's own paint puts no ink on the page. The
// shared half of a kind's `paintsNothing` — a kind with text adds "and no text", an image "and no picture".
export function isUnpainted(el: { fill: string; strokeWidth: number; strokeColor: string }): boolean {
    return !isBordered(el) && isTransparentFill(parseFill(el.fill));
}

// An element fill is the paint plus the hatch style stored beside it; a missing or unknown style reads
// as the default, the way every other stored enum does.
export function parseFill(value: string): Fill {
    const raw = jsonObject(value);
    const paint = raw && paintOf(raw);
    if (!paint) return TRANSPARENT_FILL;
    return { ...paint, style: fillStyleOf(prop(raw, 'style')) };
}

export function serializeFill(fill: Fill): string {
    return JSON.stringify(fill);
}

export function solidFill(color: string, style: FillStyle = DEFAULT_FILL_STYLE): string {
    return serializeFill({ type: 'solid', color: isColorToken(color) ? color : TRANSPARENT_COLOR, style });
}

function fillStyleOf(value: unknown): FillStyle {
    for (const style of FILL_STYLES) {
        if (style === value) return style;
    }
    return DEFAULT_FILL_STYLE;
}

// The widened codec frames use. null (⇒ '') is "no background", distinct from a transparent solid.
export function parseBackgroundFill(value: string): BackgroundFill | null {
    const raw = jsonObject(value);
    if (!raw) return null;
    const paint = paintOf(raw);
    if (paint) return paint;
    if (prop(raw, 'type') === 'image') {
        const mediaName = prop(raw, 'mediaName');
        const fit = prop(raw, 'fit');
        if (typeof mediaName !== 'string' || !isSafeMediaName(mediaName)) return null;
        if (fit !== 'cover' && fit !== 'contain') return null;
        return { type: 'image', mediaName, fit };
    }
    return null;
}

function jsonObject(value: string): object | null {
    if (value === '') return null;
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null;
    }
    return typeof raw === 'object' && raw !== null ? raw : null;
}

// The paint half both codecs share, so the element fill and a frame background agree on what a color
// and a gradient are.
function paintOf(raw: object): FillPaint | null {
    const type = prop(raw, 'type');
    if (type === 'solid') {
        const color = prop(raw, 'color');
        return isColorToken(color) ? { type: 'solid', color } : null;
    }
    if (type === 'gradient') {
        const from = prop(raw, 'from');
        const to = prop(raw, 'to');
        if (!isColorToken(from) || !isColorToken(to)) return null;
        return { type: 'gradient', from, to, angle: normalizeDegrees(prop(raw, 'angle')) };
    }
    return null;
}

export function serializeBackgroundFill(fill: BackgroundFill | null): string {
    return fill === null ? '' : JSON.stringify(fill);
}

// The SVG gradient line for a CSS angle, in objectBoundingBox units: 0deg paints bottom-to-top and the
// angle increases clockwise (the CSS linear-gradient convention getBackgroundStyle already speaks).
// Half-extent (|sin|+|cos|)/2 makes the line span the box corner-to-corner like CSS does.
export function gradientVector(angle: number): { x1: number; y1: number; x2: number; y2: number } {
    const rad = (normalizeDegrees(angle) * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const half = (Math.abs(dx) + Math.abs(dy)) / 2;
    return {
        x1: round4(0.5 - dx * half),
        y1: round4(0.5 - dy * half),
        x2: round4(0.5 + dx * half),
        y2: round4(0.5 + dy * half),
    };
}

function normalizeDegrees(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? normalizeAngle(value) : 0;
}
