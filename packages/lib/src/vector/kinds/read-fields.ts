// The reader's shared field validators. The Y.Doc is a boundary — any peer writes it — so every stored
// value passes one of these on the way into the scene, and a corrupt write degrades to the field default
// instead of reaching roughjs, SVG or a layout pass.

import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { LIGHT_EDITOR_TAGS } from '../../core/html';
import { stripNonXmlChars } from '../../core/xml';
import { isColorToken, parseFill, serializeFill } from '../fill';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_RICHTEXT_PROPS } from '../types';

// Sanity bound on spatial fields. Without a cap one client's corrupt write (say 1e15 from a math bug)
// freezes every other peer — rough fill cost scales with element area.
export const MAX_COORD = 1_000_000;

// fontSize feeds line-height math (an arrow label's height = lines × line height), so a hostile
// value would blow the shared viewBox like an uncapped labelWidth; clamp to the canvas' own range.
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;

// Rich text is the first byte-capped string field: one pasted document must not make every peer's read,
// render and export unbounded. 64 KiB per element, truncated on a UTF-8 boundary. This reader does NOT
// sanitize the markup — the DOM allowlist needs a DOM, and this module runs in the API Worker too. The
// mount seam does it instead: ElementLayer (every live/preview/present surface) and the paste planner
// both run sanitizeToLightEditorHtml, so a torn tag here is a cosmetic loss, never an injection.
const MAX_HTML_BYTES = 64 * 1024;

// Rich text nested past this many elements is flattened on read. jsdom walks every ancestor of each node it
// inserts, so the export sanitizer's parse costs depth²: 3,000 nested list levels fit in MAX_HTML_BYTES and
// held it for 30 s. The LightEditor indents without limit; 64 holds 29 list levels around every mark and a
// link, where Word and Google Docs stop at 9.
export const MAX_HTML_DEPTH = 64;

const EDITOR_TAGS = new Set(LIGHT_EDITOR_TAGS);

// One token as every HTML tokenizer reads it: a comment, ending where the tokenizer ends one; a start tag with
// plain attributes; an end tag; or text.
const HTML_TOKEN =
    /<!--(?:-?>|[\s\S]*?--!?>)|<([a-zA-Z][a-zA-Z0-9]*)(?:[\t\n\f\r ]+[a-zA-Z_:][-\w:.]*(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'=<>`]+))?)*[\t\n\f\r ]*\/?>|<\/([a-zA-Z][a-zA-Z0-9]*)[\t\n\f\r ]*>|[^<]+/y;

// An arrow's label is plain text, and both of its dimensions derive from it: the height is the line
// count times the line height (so a 200k-line label would union a 5M-unit box into the shared viewBox)
// and the SVG arm emits one <text> node per line. Cap the bytes and the lines; the in-canvas textarea
// commits through labelText, so what a user types and what the reader keeps are the same string.
export const MAX_ARROW_LABEL_BYTES = 4 * 1024;
export const MAX_ARROW_LABEL_LINES = 64;

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

// A font name reaches a CSS declaration list (rich text's style body), where a stray `;` would open a
// declaration of the writer's choosing. Only an EIGEN_FONTS name passes; the picker writes nothing else.
export function fontFamily(v: unknown, fallback = DEFAULT_FONT_FAMILY): string {
    return oneOf(v, EIGEN_FONT_NAMES, fallback);
}

// Rich-text typography bounds, shared by the document reader and the paste wire: a hostile value
// can't blow every peer's layout with 1e9 tracking or leading.
export function letterSpacingField(v: unknown): number {
    return clampNum(v, -200, 200, DEFAULT_RICHTEXT_PROPS.letterSpacing);
}

export function lineHeightField(v: unknown): number {
    return clampNum(v, 0.5, 10, DEFAULT_RICHTEXT_PROPS.lineHeight);
}

// roughjs inputs. A negative strokeWidth reaches SVG as an invalid stroke-width, and an out-of-band
// roughness or seed turns the generator's output into NaN coordinates.
export function strokeWidth(v: unknown): number {
    return clampNum(v, 0, 100, DEFAULT_ELEMENT_PROPS.strokeWidth);
}

export function roughness(v: unknown): number {
    return clampNum(v, 0, 10, DEFAULT_ELEMENT_PROPS.roughness);
}

export function seed(v: unknown): number {
    return clampNum(v, 1, 2 ** 31, DEFAULT_ELEMENT_PROPS.seed);
}

export function clampCoord(n: number): number {
    return Math.min(MAX_COORD, Math.max(-MAX_COORD, n));
}

export function str(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v : fallback;
}

// Strip what XML can't hold. The HTML-parsed live canvas tolerates it, but librsvg/WeasyPrint/strict SVG
// viewers reject it — so the reader, the one boundary every consumer shares, cleans it for previews and
// svg/png/pdf export alike.
export function cleanStr(v: unknown, fallback: string): string {
    return typeof v === 'string' ? stripNonXmlChars(v) : fallback;
}

// Colors come from the ColorPicker: hex or the 'transparent' sentinel (fill.ts owns the vocabulary).
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

// The cap lands on a code-point boundary, not a markup one: a torn tag is repaired by every consumer,
// which parses the body as HTML before it renders or serializes it.
export function htmlField(v: unknown): string {
    return capDepth(capBytes(cleanStr(v, ''), MAX_HTML_BYTES));
}

// A start tag past MAX_HTML_DEPTH goes, with its end tag, and its text stays: a too-deep list is a peer's
// mistake or an attack, and its words are still the box's content. Only the LightEditor's own tags in plain
// syntax nest the same in every parser. Past anything else (an unclosed comment, a <table> that
// opens a <tbody>, a raw-text <style>), every start tag counts and none closes, and one past the cap is
// escaped to text, so no parser can nest deeper than the scan counted.
function capDepth(html: string): string {
    const open: { tag: string; kept: boolean }[] = [];
    let depth = 0;
    let out = '';
    let at = 0;
    HTML_TOKEN.lastIndex = 0;
    for (let m = HTML_TOKEN.exec(html); m; m = HTML_TOKEN.exec(html)) {
        const [token, startTag, endTag] = m;
        let keep = true;
        if (startTag) {
            const tag = startTag.toLowerCase();
            if (!EDITOR_TAGS.has(tag)) break;
            if (tag !== 'br') {
                keep = depth < MAX_HTML_DEPTH;
                open.push({ tag, kept: keep });
                if (keep) depth++;
            }
        } else if (endTag) {
            const top = open.at(-1);
            if (top?.tag === endTag.toLowerCase()) {
                open.pop();
                keep = top.kept;
                if (keep) depth--;
            }
        }
        if (keep) out += token;
        at = HTML_TOKEN.lastIndex;
    }
    let count = depth;
    return out + html.slice(at).replace(/<(?=[a-zA-Z])/g, () => (++count > MAX_HTML_DEPTH ? '&lt;' : '<'));
}

// Newlines normalize here, not at the consumers, so the line cap and the label's height math count
// the same lines whatever a peer stored.
export function labelText(v: unknown): string {
    const capped = capBytes(cleanStr(v, '').replace(/\r\n?/g, '\n'), MAX_ARROW_LABEL_BYTES);
    const lines = capped.split('\n');
    return lines.length <= MAX_ARROW_LABEL_LINES ? capped : lines.slice(0, MAX_ARROW_LABEL_LINES).join('\n');
}

function capBytes(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= maxBytes) return value;
    let end = maxBytes;
    // step back off a continuation byte so the truncation lands on a code-point boundary
    while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}
