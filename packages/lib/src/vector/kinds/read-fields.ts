// The reader's shared field validators. The Y.Doc is a boundary — any peer writes it — so every stored
// value passes one of these on the way into the scene, and a corrupt write degrades to the field default
// instead of reaching roughjs, SVG or a layout pass.

import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { LIGHT_EDITOR_BLOCK_TAGS, LIGHT_EDITOR_TAGS, stripTagsServer, textToParagraphHtml } from '../../core/html';
import { stripNonXmlChars } from '../../core/xml';
import { isColorToken, parseFill, serializeFill } from '../fill';
import { MAX_FONT_SIZE_PX, MIN_FONT_SIZE_PX } from '../frames';
import { parsePathCommands, serializePath } from '../outline';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_RICHTEXT_PROPS } from '../types';

// Sanity bound on spatial fields. Without a cap one client's corrupt write (say 1e15 from a math bug)
// freezes every other peer — rough fill cost scales with element area.
export const MAX_COORD = 1_000_000;

// Rich text is the first byte-capped string field: one pasted document must not make every peer's read,
// render and export unbounded. 64 KiB per element, truncated on a UTF-8 boundary. This reader does NOT
// sanitize the markup — the DOM allowlist needs a DOM, and this module runs in the API Worker too. The
// mount seam does it instead: ElementLayer (every live/preview/present surface) and the paste planner
// both run sanitizeToLightEditorHtml.
export const MAX_HTML_BYTES = 64 * 1024;

// Rich text is kept as stored only when it is editor-shaped (isEditorShaped); anything else is flattened
// to plain paragraphs. jsdom walks every ancestor of each node it inserts, so the export sanitizer's parse
// costs depth²: 3,000 nested list levels fit in MAX_HTML_BYTES and held it for 30 s. The LightEditor
// indents without limit; 64 holds 29 list levels around every mark and a link, where Word and Google Docs
// stop at 9.
export const MAX_HTML_DEPTH = 64;

const EDITOR_TAGS = new Set(LIGHT_EDITOR_TAGS);
// The editor tags whose start tag makes the parser close an open <p>.
const CLOSES_P = new Set<string>(LIGHT_EDITOR_BLOCK_TAGS);

// A start tag with at most 8 plain attributes, an end tag, or text. No comment, doctype or bare `<` matches.
// The editor writes 3 at most, on <a>; jsdom dedupes a tag's attributes in quadratic time, so 10k distinct
// names on one <p> held it ~1 s.
const HTML_TOKEN =
    /<([a-z]+)(?:[\t\n\f\r ]+[a-zA-Z_:][-\w:.]*(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'=<>`]+))?){0,8}[\t\n\f\r ]*\/?>|<\/([a-z]+)[\t\n\f\r ]*>|[^<]+/y;

// An arrow's label is plain text, and both of its dimensions derive from it: the height is the line
// count times the line height (so a 200k-line label would union a 5M-unit box into the shared viewBox)
// and the SVG arm emits one <text> node per line. Cap the bytes and the lines; the in-canvas textarea
// commits through labelText, so what a user types and what the reader keeps are the same string.
export const MAX_ARROW_LABEL_BYTES = 4 * 1024;
export const MAX_ARROW_LABEL_LINES = 64;

// A path's work (render, hit test, docking, export) scales with its commands. A valid path is ASCII, so its
// length is its bytes; the canonical spelling is capped too, so what the reader stores reads back.
export const MAX_PATH_BYTES = 16 * 1024;
export const MAX_PATH_COMMANDS = 512;

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

// fontSize feeds line-height math (an arrow label's height = lines × line height), so a hostile value would blow the
// shared viewBox like an uncapped labelWidth; clamped to the range every deck reaches. A size in range reads to the bit.
export function fontSize(v: unknown): number {
    return clampNum(v, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX, DEFAULT_FONT_SIZE);
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
export function strokeWidth(v: unknown, fallback = DEFAULT_ELEMENT_PROPS.strokeWidth): number {
    return clampNum(v, 0, 100, fallback);
}

export function roughness(v: unknown, fallback = DEFAULT_ELEMENT_PROPS.roughness): number {
    return clampNum(v, 0, 10, fallback);
}

export function seed(v: unknown, fallback = DEFAULT_ELEMENT_PROPS.seed): number {
    return clampNum(v, 1, 2 ** 31, fallback);
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
// Anything else → the field default, or null for a chart's automatic color; this closes `url(...)`
// paint-server smuggling into export.
export function color<T extends string | null>(v: unknown, fallback: T): string | T {
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

// A body that isn't editor-shaped is flattened whole, one paragraph per line of its text, so no parser
// builds more than the scan counted. Where the byte cap tears a tag at the end of either, it goes.
export function htmlField(v: unknown): string {
    const html = capHtmlBytes(cleanStr(v, ''));
    if (isEditorShaped(html)) return html;
    return capHtmlBytes(textToParagraphHtml(stripTagsServer(html).replace(/\n+/g, '\n')));
}

// Editor-shaped: markup every HTML parser builds exactly as written, closing nothing before the body does,
// so a parse holds MAX_HTML_DEPTH elements at most and no formatting element is rebuilt later. That is
// only LightEditor tags in plain syntax, every end tag closing the innermost open element, no block or
// <li> inside an open <p>, <li> only directly in a list, and no <a> inside an <a>. An implied close
// leaves the formatting elements it pops on jsdom's active list, which rebuilds them for every later
// paragraph: 64 KiB of such bodies under the depth cap held it for 17 s.
function isEditorShaped(html: string): boolean {
    const open: string[] = [];
    HTML_TOKEN.lastIndex = 0;
    while (HTML_TOKEN.lastIndex < html.length) {
        const token = HTML_TOKEN.exec(html);
        if (!token) return false;
        const [, start, end] = token;
        if (start) {
            if (!EDITOR_TAGS.has(start)) return false;
            if (CLOSES_P.has(start) && open.includes('p')) return false;
            if (start === 'li' && open.at(-1) !== 'ul' && open.at(-1) !== 'ol') return false;
            if (start === 'a' && open.includes('a')) return false;
            if (start !== 'br' && open.push(start) > MAX_HTML_DEPTH) return false;
        } else if (end && open.pop() !== end) {
            return false;
        }
    }
    return true;
}

// Only a truncated body loses its trailing `<…`: an untouched one keeps a bare `<` as text.
function capHtmlBytes(html: string): string {
    const capped = capBytes(html, MAX_HTML_BYTES);
    if (capped === html) return html;
    const lt = capped.lastIndexOf('<');
    return lt > capped.lastIndexOf('>') ? capped.slice(0, lt) : capped;
}

// The canonical `path`, or null for a malformed or oversized one, which the kind drops.
export function parseNormalizedPath(v: unknown): string | null {
    if (typeof v !== 'string' || v.length > MAX_PATH_BYTES) return null;
    const commands = parsePathCommands(v);
    if (commands === null || commands.length === 0 || commands.length > MAX_PATH_COMMANDS) return null;
    const path = serializePath(commands);
    return path.length <= MAX_PATH_BYTES ? path : null;
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
