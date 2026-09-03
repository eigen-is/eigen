// The stored-fill codec. An element's `fill` is a JSON scalar like `points` — one string field, so the
// scalar-only ELEMENT_FIELDS convention holds — and a frame's `background` is the same codec widened to
// the image variant. Strict: '' or anything malformed reads back as the transparent solid fill, so a
// corrupt peer write can never throw on a render path.

import type { BackgroundFill, Fill } from '../types/background';
import { prop } from './types';

// "Paint nothing" as a bare colour: a fill with no paint, a scene with no background, a shape or box
// whose border is switched off. One token, so the predicate and every writer agree on the spelling.
export const TRANSPARENT_COLOR = 'transparent';

export const TRANSPARENT_FILL: Fill = { type: 'solid', color: TRANSPARENT_COLOR };

// Colours come from the ColorPicker: hex (#rgb/#rrggbb/#rrggbbaa) or the 'transparent' sentinel.
// Anything else is rejected; this closes `url(...)` paint-server smuggling into export.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColorToken(v: unknown): v is string {
    return typeof v === 'string' && (v === TRANSPARENT_COLOR || HEX_COLOR.test(v));
}

// The scene background, an element's fill and a switched-off border all answer through this predicate.
export function isTransparentColor(color: string): boolean {
    return color === TRANSPARENT_COLOR;
}

export function isTransparentFill(fill: Fill): boolean {
    return fill.type === 'solid' && isTransparentColor(fill.color);
}

export function parseFill(value: string): Fill {
    const fill = parseBackgroundFill(value);
    if (!fill || fill.type === 'image') return TRANSPARENT_FILL;
    return fill;
}

export function serializeFill(fill: Fill): string {
    return JSON.stringify(fill);
}

export function solidFill(color: string): string {
    return serializeFill({ type: 'solid', color: isColorToken(color) ? color : 'transparent' });
}

// The widened codec frames use. null (⇒ '') is "no background", distinct from a transparent solid.
export function parseBackgroundFill(value: string): BackgroundFill | null {
    if (value === '') return null;
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
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
    if (type === 'image') {
        const mediaName = prop(raw, 'mediaName');
        const fit = prop(raw, 'fit');
        if (typeof mediaName !== 'string' || !isSafeMediaName(mediaName)) return null;
        if (fit !== 'cover' && fit !== 'contain') return null;
        return { type: 'image', mediaName, fit };
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
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return ((value % 360) + 360) % 360;
}

// The media-name guard listEigenMediaRefs already enforces: no traversal, no control characters.
function isSafeMediaName(name: string): boolean {
    if (name === '' || name.includes('/') || name.includes('\\')) return false;
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

function round4(n: number): number {
    return Math.round(n * 10_000) / 10_000;
}
