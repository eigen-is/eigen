// Materialize a vector container's Y.Doc into a plain VectorScene. Worker-safe (yjs only),
// mirrors document/slides.ts readDeckFromDoc but per-element-Map. Every v1 field is a scalar
// or string, so primitive reads suffice even when the server hydrates values via Y.applyUpdate.

import type * as Y from 'yjs';
import { validateElbowPoints } from './elbow-pins';
import { parseBackgroundFill, parseFill, serializeBackgroundFill, serializeFill } from './fill';
import { orderByFractionalIndex, syncInvalidIndices } from './fractional-index';
import { FRAME_HEIGHT, FRAME_WIDTH, type VectorFrame } from './frames';
import { parsePoints, parsePressures, serializePoints, serializePressures } from './geometry';
import {
    ARROWHEADS,
    CORNERS,
    DEFAULT_ARROW_PROPS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DEFAULT_LINEAR_ROUNDNESS,
    DEFAULT_OBJECT_FIT,
    DEFAULT_SCENE_META,
    DEFAULT_SKETCH_PROPS,
    FILL_STYLES,
    type FixedSegment,
    FONT_STYLES,
    FONT_WEIGHTS,
    isBindable,
    isVectorElementType,
    OBJECT_FITS,
    parseBinding,
    parseFixedSegments,
    parseIdList,
    ROUNDNESS,
    STROKE_STYLES,
    serializeBinding,
    serializeFixedSegments,
    serializeIdList,
    TEXT_ALIGNS,
    TEXT_DECORATIONS,
    VERTICAL_ALIGNS,
    type VectorElement,
    type VectorElementBase,
    type VectorScene,
} from './types';

// Sanity bound on spatial fields. The doc is a boundary (any peer writes it); without a cap
// one client's corrupt write (say 1e15 from a math bug) freezes every other peer — rough
// fill cost scales with element area.
const MAX_COORD = 1_000_000;

// fontSize feeds line-height math (an arrow label's height = lines × line height), so a hostile
// value would blow the shared viewBox like an uncapped labelWidth; clamp to the canvas' own range.
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;

export function readVectorFromDoc(doc: Y.Doc): VectorScene {
    const elementsMap = doc.getMap('elements');
    const framesMap = doc.getMap('frames');
    const metaMap = doc.getMap('meta');

    const frames = readFrames(framesMap);
    const elements: VectorElement[] = [];
    for (const value of elementsMap.values()) {
        const el = readElement(value);
        if (el) elements.push(el);
    }

    // Now that every element is known, unbind any arrow whose bound shape is gone.
    clearDanglingBindings(elements);

    // Order by z-index, then heal any collisions/invalid runs from concurrent inserts.
    const ordered = syncInvalidIndices(orderByFractionalIndex(elements));

    const background = color(metaMap.get('background'), DEFAULT_SCENE_META.background);
    const gridSize = num(metaMap.get('gridSize'), DEFAULT_SCENE_META.gridSize);
    return { elements: ordered, frames, meta: { background, gridSize } };
}

// Frames are ordered by fractional index like elements, and heal the same way. Every frame is
// 16:9, so the size is the constant, never a stored field.
function readFrames(framesMap: Y.Map<unknown>): VectorFrame[] {
    const frames: VectorFrame[] = [];
    for (const value of framesMap.values()) {
        if (!isYMapLike(value)) continue;
        const id = value.get('id');
        if (typeof id !== 'string' || id === '') continue;
        frames.push({
            id,
            index: str(value.get('index'), ''),
            name: cleanStr(value.get('name'), ''),
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            background: serializeBackgroundFill(parseBackgroundFill(str(value.get('background'), ''))),
        });
    }
    return syncInvalidIndices(orderByFractionalIndex(frames));
}

function readElement(value: unknown): VectorElement | null {
    // A per-element Y.Map exposes .get; foreign/partial values without it are skipped.
    if (!isYMapLike(value)) return null;
    const type = value.get('type');
    const id = value.get('id');
    if (typeof id !== 'string' || !isVectorElementType(type)) return null;

    const base: VectorElementBase = {
        id,
        type,
        x: coord(value.get('x')),
        y: coord(value.get('y')),
        width: size(value.get('width')),
        height: size(value.get('height')),
        angle: num(value.get('angle'), 0),
        index: str(value.get('index'), ''),
        frameId: str(value.get('frameId'), ''),
        commentCardIds: serializeIdList(parseIdList(str(value.get('commentCardIds'), ''))),
        opacity: Math.min(100, Math.max(0, num(value.get('opacity'), DEFAULT_ELEMENT_PROPS.opacity))),
        locked: bool(value.get('locked'), DEFAULT_ELEMENT_PROPS.locked),
        strokeColor: color(value.get('strokeColor'), DEFAULT_ELEMENT_PROPS.strokeColor),
        strokeWidth: num(value.get('strokeWidth'), DEFAULT_ELEMENT_PROPS.strokeWidth),
        strokeStyle: oneOf(value.get('strokeStyle'), STROKE_STYLES, DEFAULT_ELEMENT_PROPS.strokeStyle),
    };

    // roughjs tuning rides the six sketched kinds, never image or rich text.
    const sketch = {
        roughness: num(value.get('roughness'), DEFAULT_SKETCH_PROPS.roughness),
        seed: num(value.get('seed'), DEFAULT_SKETCH_PROPS.seed),
    };
    const paint = {
        fill: fill(value.get('fill')),
        fillStyle: oneOf(value.get('fillStyle'), FILL_STYLES, 'solid'),
    };

    switch (base.type) {
        case 'rectangle':
        case 'diamond':
            return {
                ...base,
                ...sketch,
                ...paint,
                type: base.type,
                corners: oneOf(value.get('corners'), CORNERS, DEFAULT_CORNERS),
            };
        case 'ellipse':
            return { ...base, ...sketch, ...paint, type: 'ellipse' };
        case 'richtext':
            return {
                ...base,
                ...paint,
                type: 'richtext',
                html: capBytes(cleanStr(value.get('html'), ''), MAX_HTML_BYTES),
                corners: oneOf(value.get('corners'), CORNERS, DEFAULT_CORNERS),
                fontFamily: cleanStr(value.get('fontFamily'), DEFAULT_FONT_FAMILY),
                fontSize: fontSize(value.get('fontSize')),
                fontWeight: oneOf(value.get('fontWeight'), FONT_WEIGHTS, 'normal'),
                fontStyle: oneOf(value.get('fontStyle'), FONT_STYLES, 'normal'),
                textDecoration: oneOf(value.get('textDecoration'), TEXT_DECORATIONS, 'none'),
                textAlign: oneOf(value.get('textAlign'), TEXT_ALIGNS, 'left'),
                verticalAlign: oneOf(value.get('verticalAlign'), VERTICAL_ALIGNS, 'top'),
                color: color(value.get('color'), DEFAULT_ELEMENT_PROPS.strokeColor),
                highlightColor: color(value.get('highlightColor'), 'transparent'),
                letterSpacing: num(value.get('letterSpacing'), 0),
                lineHeight: Math.min(10, Math.max(0.5, num(value.get('lineHeight'), 1.2))),
            };
        case 'image':
            return {
                ...base,
                type: 'image',
                mediaName: str(value.get('mediaName'), ''),
                corners: oneOf(value.get('corners'), CORNERS, DEFAULT_CORNERS),
                objectFit: oneOf(value.get('objectFit'), OBJECT_FITS, DEFAULT_OBJECT_FIT),
            };
        case 'freedraw':
        case 'line': {
            // A linear element without points is meaningless — skip it like an unknown type. Coords are
            // clamped per-axis (same bound as scalar spatial fields) so one corrupt peer write can't freeze
            // others; re-serialized back to the stored string form.
            const points = parsePoints(str(value.get('points'), ''));
            if (points.length === 0) return null;
            const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
            // Pen pressure (freedraw only) rides a separate index-aligned array. A stored simulate flag,
            // a missing/garbage array, or a length that drifts from the surviving points (a non-finite
            // point was dropped) all collapse to '' + simulate — so the invariant "pressures[i] pairs
            // points[i]" holds for every consumer, and legacy strokes render exactly as before.
            const pressures = base.type === 'freedraw' ? parsePressures(str(value.get('pressures'), '')) : [];
            const simulate = base.type !== 'freedraw' || bool(value.get('simulatePressure'), true);
            const useReal = !simulate && pressures.length > 0 && pressures.length === clamped.length;
            return {
                ...base,
                ...sketch,
                ...paint,
                type: base.type,
                roundness: oneOf(value.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
                points: serializePoints(clamped),
                pressures: useReal ? serializePressures(pressures) : '',
                simulatePressure: !useReal,
            };
        }
        case 'arrow': {
            // An arrow is a linear element plus heads, forward bindings and an optional label. Its points
            // obey the same skip/clamp rules as a line. Bindings are normalized to a canonical string here
            // (or '' when invalid); a binding whose target is absent/not bindable is cleared in a second
            // pass over the whole scene (clearDanglingBindings) — the doc is left untouched.
            const points = parsePoints(str(value.get('points'), ''));
            if (points.length === 0) return null;
            const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
            const elbow = bool(value.get('elbow'), DEFAULT_ARROW_PROPS.elbow);
            return {
                ...base,
                ...sketch,
                type: 'arrow',
                // An elbow arrow's route is derived in the unrotated local frame, so it pins angle 0 (the
                // panel hides rotation for it) — the reader forces it regardless of what a peer stored.
                angle: elbow ? 0 : base.angle,
                roundness: oneOf(value.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
                points: serializePoints(clamped),
                elbow,
                // Pinned route segments live only on an elbow arrow — a straight arrow ignores them (its
                // route is the raw chord). Re-serialized through the canonical form: garbage and non
                // axis-aligned entries drop, coords clamp like the endpoints, '' when none remain.
                fixedSegments: elbow ? fixedSegments(value.get('fixedSegments'), clamped) : '',
                startArrowhead: oneOf(value.get('startArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.startArrowhead),
                endArrowhead: oneOf(value.get('endArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.endArrowhead),
                startBinding: binding(value.get('startBinding')),
                endBinding: binding(value.get('endBinding')),
                text: cleanStr(value.get('text'), DEFAULT_ARROW_PROPS.text),
                fontSize: fontSize(value.get('fontSize')),
                fontFamily: cleanStr(value.get('fontFamily'), DEFAULT_ARROW_PROPS.fontFamily),
                // Non-negative and capped at MAX_COORD like the spatial fields — a hostile 1e9 would
                // otherwise blow the shared viewBox (elementBounds unions the label rect) for every peer.
                labelWidth: Math.min(
                    MAX_COORD,
                    Math.max(0, num(value.get('labelWidth'), DEFAULT_ARROW_PROPS.labelWidth)),
                ),
            };
        }
    }
}

// A stored binding materializes to its canonical `{"elementId","fixedPoint"}` string, or '' when the
// value is missing/malformed (parseBinding rejects it). Target existence is a whole-scene question, so
// it is resolved separately in clearDanglingBindings once every element is read.
function binding(v: unknown): string {
    const parsed = parseBinding(str(v, ''));
    return parsed ? serializeBinding(parsed) : '';
}

// Pinned segments to canonical form. A pinned elbow arrow stores its full polyline in `points`, so
// the pins are validated against it: the polyline must be a valid orthogonal run of >= 4 points, each pin
// index must fall on an interior segment (2 .. len-2 — the first and last segment can't be fixed), and each
// pin's start/end are REBUILT from the polyline at its index so the stored copies can never drift. Any
// violation ⇒ drop ALL pins ('' ⇒ the arrow self-heals to the derived route). Never throws.
function fixedSegments(v: unknown, points: { x: number; y: number }[]): string {
    const parsed = parseFixedSegments(str(v, ''));
    if (parsed.segments.length === 0) return '';
    if (points.length < 4 || !validateElbowPoints(points)) return '';
    const kept: FixedSegment[] = [];
    for (const seg of parsed.segments) {
        if (seg.index < 2 || seg.index > points.length - 2) continue;
        kept.push({
            index: seg.index,
            start: [points[seg.index - 1].x, points[seg.index - 1].y],
            end: [points[seg.index].x, points[seg.index].y],
        });
    }
    if (kept.length === 0) return '';
    return serializeFixedSegments({
        segments: kept,
        startIsSpecial: parsed.startIsSpecial,
        endIsSpecial: parsed.endIsSpecial,
    });
}

// Second pass: a binding whose target no longer exists — or is no longer a bindable shape — is
// unbound. Mutates the freshly-materialized elements in place; the Y.Doc is never written, so
// the next real write of that arrow is what persists the cleared value.
function clearDanglingBindings(elements: VectorElement[]): void {
    const bindable = new Set<string>();
    for (const el of elements) {
        if (isBindable(el)) bindable.add(el.id);
    }
    for (const el of elements) {
        if (el.type !== 'arrow') continue;
        if (!targetPresent(el.startBinding, bindable)) el.startBinding = '';
        if (!targetPresent(el.endBinding, bindable)) el.endBinding = '';
    }
}

function targetPresent(bindingStr: string, bindable: Set<string>): boolean {
    const parsed = parseBinding(bindingStr);
    return parsed !== null && bindable.has(parsed.elementId);
}

type YMapLike = { get(key: string): unknown };

function isYMapLike(value: unknown): value is YMapLike {
    return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function';
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coord(v: unknown): number {
    return clampCoord(num(v, 0));
}

// Extents are additionally floored at 0 — the model never stores a negative size, and a hostile
// negative width/height would reach SVG as an invalid attribute.
function size(v: unknown): number {
    return Math.max(0, coord(v));
}

function fontSize(v: unknown): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, num(v, DEFAULT_FONT_SIZE)));
}

function clampCoord(n: number): number {
    return Math.min(MAX_COORD, Math.max(-MAX_COORD, n));
}

function str(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v : fallback;
}

// Strip XML-invalid control chars (U+0000–U+001F except tab/LF/CR). The HTML-parsed live canvas
// tolerates them, but librsvg/WeasyPrint/strict SVG viewers reject them — so the reader, the one
// boundary every consumer shares, cleans them for previews and svg/png/pdf export alike.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping exactly those chars is the point
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function cleanStr(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v.replace(XML_INVALID, '') : fallback;
}

// Colours come from the ColorPicker: hex (#rgb/#rrggbb/#rrggbbaa) or the 'transparent' sentinel.
// Anything else → the field default; this closes `url(...)` paint-server smuggling into export.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function color(v: unknown, fallback: string): string {
    return typeof v === 'string' && (v === 'transparent' || HEX_COLOR.test(v)) ? v : fallback;
}

// A stored fill is re-serialized through the codec, so a malformed peer write materializes as the
// transparent solid fill instead of reaching roughjs as a paint-server string.
function fill(v: unknown): string {
    return serializeFill(parseFill(str(v, '')));
}

// Rich text is the first byte-capped string field: one pasted document must not be able to make every
// peer's read, render and export unbounded.
const MAX_HTML_BYTES = 64 * 1024;

function capBytes(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= maxBytes) return value;
    let end = maxBytes;
    // step back off a continuation byte so the truncation lands on a code-point boundary
    while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return fallback;
}
