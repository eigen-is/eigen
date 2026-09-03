// The reader's shared field validators. The Y.Doc is a boundary — any peer writes it — so every stored
// value passes one of these on the way into the scene, and a corrupt write degrades to the field default
// instead of reaching roughjs, SVG or a layout pass.

import { isColorToken, parseFill, serializeFill } from '../fill';
import { DEFAULT_FONT_SIZE } from '../types';

// Sanity bound on spatial fields. Without a cap one client's corrupt write (say 1e15 from a math bug)
// freezes every other peer — rough fill cost scales with element area.
export const MAX_COORD = 1_000_000;

// fontSize feeds line-height math (an arrow label's height = lines × line height), so a hostile
// value would blow the shared viewBox like an uncapped labelWidth; clamp to the canvas' own range.
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;

// Rich text is the first byte-capped string field: one pasted document must not make every peer's read,
// render and export unbounded. 64 KiB per element, truncated on a UTF-8 boundary. The truncation can
// leave an unbalanced tag; every consumer that mounts this html sanitises at its own seam, so a torn tag
// is a cosmetic loss, never an injection.
export const MAX_HTML_BYTES = 64 * 1024;

export type YMapLike = { get(key: string): unknown };

export function isYMapLike(value: unknown): value is YMapLike {
    return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function';
}

export function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
    return Math.min(max, Math.max(min, num(v, fallback)));
}

export function coord(v: unknown): number {
    return clampCoord(num(v, 0));
}

// Extents are additionally floored at 0 — the model never stores a negative size, and a hostile
// negative width/height would reach SVG as an invalid attribute.
export function size(v: unknown): number {
    return Math.max(0, coord(v));
}

export function fontSize(v: unknown): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, num(v, DEFAULT_FONT_SIZE)));
}

export function clampCoord(n: number): number {
    return Math.min(MAX_COORD, Math.max(-MAX_COORD, n));
}

export function str(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v : fallback;
}

// Strip XML-invalid control chars (U+0000–U+001F except tab/LF/CR). The HTML-parsed live canvas
// tolerates them, but librsvg/WeasyPrint/strict SVG viewers reject them — so the reader, the one
// boundary every consumer shares, cleans them for previews and svg/png/pdf export alike.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping exactly those chars is the point
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function cleanStr(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v.replace(XML_INVALID, '') : fallback;
}

// Colours come from the ColorPicker: hex or the 'transparent' sentinel (fill.ts owns the vocabulary).
// Anything else → the field default; this closes `url(...)` paint-server smuggling into export.
export function color(v: unknown, fallback: string): string {
    return isColorToken(v) ? v : fallback;
}

export function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return fallback;
}

// A stored fill is re-serialized through the codec, so a malformed peer write materializes as the
// transparent solid fill instead of reaching roughjs as a paint-server string.
export function fillField(v: unknown): string {
    return serializeFill(parseFill(str(v, '')));
}

export function htmlField(v: unknown): string {
    return capBytes(cleanStr(v, ''), MAX_HTML_BYTES);
}

export function capBytes(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= maxBytes) return value;
    let end = maxBytes;
    // step back off a continuation byte so the truncation lands on a code-point boundary
    while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}
