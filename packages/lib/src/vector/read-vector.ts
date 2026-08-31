// Materialize a vector container's Y.Doc into a plain VectorScene. Worker-safe (yjs only),
// mirrors document/slides.ts readDeckFromDoc but per-element-Map. Every v1 field is a scalar
// or string, so — unlike slides' commentCardIds — there is no Y.Array branch;
// primitive reads suffice even when the server hydrates values via Y.applyUpdate.

import type * as Y from 'yjs';
import { validateElbowPoints } from './elbow-pins';
import { orderByFractionalIndex, syncInvalidIndices } from './fractional-index';
import { parsePoints, serializePoints } from './geometry';
import {
    ARROWHEADS,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_LINEAR_ROUNDNESS,
    DEFAULT_SCENE_META,
    DEFAULT_SHAPE_ROUNDNESS,
    DEFAULT_TEXT_PROPS,
    FILL_STYLES,
    type FixedSegment,
    isBindable,
    isVectorElementType,
    parseBinding,
    parseFixedSegments,
    ROUNDNESS,
    STROKE_STYLES,
    serializeBinding,
    serializeFixedSegments,
    TEXT_ALIGNS,
    type VectorElement,
    type VectorElementBase,
    type VectorScene,
} from './types';

// Sanity bound on spatial fields. The doc is a boundary (any peer writes it); without a cap
// one client's corrupt write (say 1e15 from a math bug) freezes every other peer — rough
// fill cost scales with element area.
const MAX_COORD = 1_000_000;

// fontSize feeds line-height math (an arrow label's height = lines × line height, R3.6), so a hostile
// value would blow the shared viewBox like an uncapped labelWidth; clamp to the canvas' own range.
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 400;

export function readVectorFromDoc(doc: Y.Doc): VectorScene {
    const elementsMap = doc.getMap('elements');
    const metaMap = doc.getMap('meta');

    const elements: VectorElement[] = [];
    for (const value of elementsMap.values()) {
        const el = readElement(value);
        if (el) elements.push(el);
    }

    // Now that every element is known, unbind any arrow whose bound shape is gone (R3.2).
    clearDanglingBindings(elements);

    // Order by z-index, then heal any collisions/invalid runs from concurrent inserts.
    const ordered = syncInvalidIndices(orderByFractionalIndex(elements));

    const background = color(metaMap.get('background'), DEFAULT_SCENE_META.background);
    const gridSize = num(metaMap.get('gridSize'), DEFAULT_SCENE_META.gridSize);
    return { elements: ordered, meta: { background, gridSize } };
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
        width: coord(value.get('width')),
        height: coord(value.get('height')),
        angle: num(value.get('angle'), 0),
        strokeColor: color(value.get('strokeColor'), DEFAULT_ELEMENT_PROPS.strokeColor),
        backgroundColor: color(value.get('backgroundColor'), DEFAULT_ELEMENT_PROPS.backgroundColor),
        fillStyle: oneOf(value.get('fillStyle'), FILL_STYLES, DEFAULT_ELEMENT_PROPS.fillStyle),
        strokeWidth: num(value.get('strokeWidth'), DEFAULT_ELEMENT_PROPS.strokeWidth),
        strokeStyle: oneOf(value.get('strokeStyle'), STROKE_STYLES, DEFAULT_ELEMENT_PROPS.strokeStyle),
        roughness: num(value.get('roughness'), DEFAULT_ELEMENT_PROPS.roughness),
        seed: num(value.get('seed'), 0),
        opacity: Math.min(100, Math.max(0, num(value.get('opacity'), DEFAULT_ELEMENT_PROPS.opacity))),
        locked: bool(value.get('locked'), DEFAULT_ELEMENT_PROPS.locked),
        index: str(value.get('index'), ''),
    };

    switch (base.type) {
        case 'rectangle':
        case 'diamond':
        case 'ellipse':
            return {
                ...base,
                type: base.type,
                roundness: oneOf(value.get('roundness'), ROUNDNESS, DEFAULT_SHAPE_ROUNDNESS),
            };
        case 'text':
            return {
                ...base,
                type: 'text',
                text: cleanStr(value.get('text'), DEFAULT_TEXT_PROPS.text),
                fontSize: fontSize(value.get('fontSize')),
                fontFamily: cleanStr(value.get('fontFamily'), DEFAULT_TEXT_PROPS.fontFamily),
                textAlign: oneOf(value.get('textAlign'), TEXT_ALIGNS, DEFAULT_TEXT_PROPS.textAlign),
            };
        case 'image':
            return { ...base, type: 'image', mediaName: str(value.get('mediaName'), '') };
        case 'freedraw':
        case 'line': {
            // A linear element without points is meaningless — skip it like an unknown type. Coords are
            // clamped per-axis (same bound as scalar spatial fields) so one corrupt peer write can't freeze
            // others; re-serialized back to the stored string form.
            const points = parsePoints(str(value.get('points'), ''));
            if (points.length === 0) return null;
            const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
            return {
                ...base,
                type: base.type,
                roundness: oneOf(value.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
                points: serializePoints(clamped),
            };
        }
        case 'arrow': {
            // An arrow is a linear element plus heads, forward bindings and an optional label. Its points
            // obey the same skip/clamp rules as a line. Bindings are normalized to a canonical string here
            // (or '' when invalid); a binding whose target is absent/not bindable is cleared in a second
            // pass over the whole scene (clearDanglingBindings) — the doc is left untouched (R3.2/R3.7).
            const points = parsePoints(str(value.get('points'), ''));
            if (points.length === 0) return null;
            const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
            const elbow = bool(value.get('elbow'), DEFAULT_ARROW_PROPS.elbow);
            return {
                ...base,
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
                text: cleanStr(value.get('text'), DEFAULT_TEXT_PROPS.text),
                fontSize: fontSize(value.get('fontSize')),
                fontFamily: cleanStr(value.get('fontFamily'), DEFAULT_TEXT_PROPS.fontFamily),
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

// Pinned segments to canonical form (P12). A pinned elbow arrow stores its full polyline in `points`, so
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
// unbound (R3.2). Mutates the freshly-materialized elements in place; the Y.Doc is never written, so
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

function fontSize(v: unknown): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, num(v, DEFAULT_TEXT_PROPS.fontSize)));
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

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return fallback;
}
