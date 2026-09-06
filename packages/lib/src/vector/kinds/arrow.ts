import type { Drawable } from 'roughjs/bin/core';
import { RoughGenerator } from 'roughjs/bin/generator';
import { validateElbowPoints } from '../elbow-pins';
import {
    arrowLabelBox,
    type Bounds,
    distanceToPolyline,
    getElementBounds,
    LINEAR_HIT_SCREEN_FACTOR,
    linearLocalToScene,
    linearSceneToLocal,
    type Point,
    parsePoints,
    pointsBounds,
    serializePoints,
    unionBounds,
} from '../geometry';
import { polylineOutline } from '../outline';
import {
    ARROWHEADS,
    DEFAULT_ARROW_PROPS,
    DEFAULT_LINEAR_ROUNDNESS,
    type FixedSegment,
    parseBinding,
    parseFixedSegments,
    ROUNDNESS,
    serializeBinding,
    serializeFixedSegments,
    type VectorArrowElement,
} from '../types';
import { elbowRoundedShaftPath, labelClipPath, renderArrowhead, renderArrowLabel } from './arrow-render';
import { defineKind } from './kind';
import {
    bool,
    clampCoord,
    fontFamily,
    fontSize,
    labelText,
    MAX_COORD,
    num,
    oneOf,
    roughness,
    seed,
    str,
} from './read-fields';
import { baseRoughOptions, drawableToSvg, svgId } from './render-utils';

export const arrowKind = defineKind<VectorArrowElement>({
    type: 'arrow',
    is: (el): el is VectorArrowElement => el.type === 'arrow',
    capabilities: {
        fill: false,
        fillStyle: false,
        strokeStyle: true,
        roughness: true,
        corners: false,
        edges: true,
        strokeOptional: false,
        bindable: false,
        creation: 'polyline',
    },
    defaults: (style) => ({
        ...DEFAULT_ARROW_PROPS,
        roughness: style.roughness,
        seed: 0, // the writer replaces it with a random one; 0 keeps `defaults` pure
        points: '',
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
    }),
    // An arrow is a linear element plus heads, forward bindings and an optional label. Its points obey the
    // same skip/clamp rules as a line. Bindings are normalized to a canonical string here (or '' when
    // invalid); a binding whose target is absent/not bindable is cleared in a second pass over the whole
    // scene (clearDanglingBindings) — the doc is left untouched.
    read: (src, base) => {
        const points = parsePoints(str(src.get('points'), ''));
        if (points.length === 0) return null;
        // Re-read through the stored form: `points` is 2-dp rounded on the way out, and the pins below
        // are rebuilt from it, so both copies must be the coordinates every consumer sees.
        const stored = serializePoints(points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) })));
        const clamped = parsePoints(stored);
        const elbow = bool(src.get('elbow'), DEFAULT_ARROW_PROPS.elbow);
        return {
            ...base,
            type: 'arrow',
            // An elbow arrow's route is derived in the unrotated local frame, so it pins angle 0 (the
            // panel hides rotation for it) — the reader forces it regardless of what a peer stored.
            angle: elbow ? 0 : base.angle,
            roughness: roughness(src.get('roughness')),
            seed: seed(src.get('seed')),
            roundness: oneOf(src.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
            points: stored,
            elbow,
            // Pinned route segments live only on an elbow arrow — a straight arrow ignores them (its
            // route is the raw chord). Re-serialized through the canonical form: garbage and non
            // axis-aligned entries drop, coords clamp like the endpoints, '' when none remain.
            fixedSegments: elbow ? fixedSegments(src.get('fixedSegments'), clamped) : '',
            startArrowhead: oneOf(src.get('startArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.startArrowhead),
            endArrowhead: oneOf(src.get('endArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.endArrowhead),
            startBinding: binding(src.get('startBinding')),
            endBinding: binding(src.get('endBinding')),
            text: labelText(src.get('text')),
            fontSize: fontSize(src.get('fontSize')),
            fontFamily: fontFamily(src.get('fontFamily')),
            // Non-negative and capped at MAX_COORD like the spatial fields — a hostile 1e9 would
            // otherwise blow the shared viewBox (bounds unions the label rect) for every peer.
            labelWidth: Math.min(MAX_COORD, Math.max(0, num(src.get('labelWidth'), DEFAULT_ARROW_PROPS.labelWidth))),
        };
    },
    // An arrow unions its rotated label rect into the box bounds, so a wide label on a short arrow is not
    // clipped by the viewBox nor missed by marquee/ring. `route` (the derived elbow polyline) replaces the
    // stored box for an elbow arrow, whose bends spill outside the 2-endpoint box.
    bounds: (el, route): Bounds => {
        // An empty route is no route: pointsBounds([]) is ±Infinity, which would poison the shared viewBox.
        const box = route?.length ? pointsBounds(route.map((p) => linearLocalToScene(el, p))) : getElementBounds(el);
        const label = arrowLabelBox(el, route);
        if (!label) return box;
        const hw = label.width / 2;
        const hh = label.height / 2;
        const corners: Point[] = [
            { x: label.center.x - hw, y: label.center.y - hh },
            { x: label.center.x + hw, y: label.center.y - hh },
            { x: label.center.x + hw, y: label.center.y + hh },
            { x: label.center.x - hw, y: label.center.y + hh },
        ].map((c) => linearLocalToScene(el, c));
        return unionBounds(box, pointsBounds(corners));
    },
    // An arrow is hit on its polyline (like a line) OR inside its label rect — both measured in the arrow's
    // local frame (the label rotates with the arrow), so a wide label on a short arrow is still selectable.
    hitTest: (el, point, threshold, route) => {
        const points = route ?? parsePoints(el.points);
        if (points.length === 0) return false;
        const p = linearSceneToLocal(el, point);
        if (distanceToPolyline(points, p) <= Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, el.strokeWidth / 2 + 0.1))
            return true;
        const label = arrowLabelBox(el, route);
        return (
            label !== null &&
            Math.abs(p.x - label.center.x) <= label.width / 2 &&
            Math.abs(p.y - label.center.y) <= label.height / 2
        );
    },
    outline: (el) => polylineOutline(parsePoints(el.points).map((p) => linearLocalToScene(el, p))),
    // An arrow is a line shaft (sharp linearPath / round curve, never filled) plus roughjs heads on either
    // end and an optional label. The label rect (+5px padding) is cut out of the shaft with an even-odd
    // clip hole so the shaft shows nothing under the text; heads and label draw on top, unclipped. All
    // coordinates are the arrow's local frame — the group transform rotates the whole arrow, label and all.
    render: (el, ctx) => {
        const gen = new RoughGenerator();
        const points = ctx.route ?? parsePoints(el.points);
        if (points.length === 0) return { svg: '<g stroke-linecap="round"></g>' };
        const coords = points.map((p): [number, number] => [p.x, p.y]);
        const options = baseRoughOptions(el, false);
        // A round elbow rounds each bend with a quadratic arc (Excalidraw's generateElbowArrowShape, radius
        // 16), fed to roughjs as a path — first/last points and the final segment's direction are untouched,
        // so heads and the raw-route label math are unaffected. A sharp elbow (and any elbow with no scene
        // context) stays a linearPath; a non-elbow round arrow curves through its vertices.
        let shaftDrawable: Drawable;
        if (el.elbow) {
            shaftDrawable =
                el.roundness === 'round'
                    ? gen.path(elbowRoundedShaftPath(points), baseRoughOptions(el, true))
                    : gen.linearPath(coords, options);
        } else {
            shaftDrawable = el.roundness === 'round' ? gen.curve(coords, options) : gen.linearPath(coords, options);
        }
        const shaftPaths = drawableToSvg(shaftDrawable);

        const label = arrowLabelBox(el, ctx.route);
        let shaft = shaftPaths;
        let defs = '';
        if (label) {
            const clipId = svgId('arrow-label-clip', el.id);
            defs = `<clipPath id="${clipId}">${labelClipPath(points, label, el.strokeWidth)}</clipPath>`;
            shaft = `<g clip-path="url(#${clipId})">${shaftPaths}</g>`;
        }

        const heads =
            renderArrowhead(gen, el, points, 'start', el.startArrowhead) +
            renderArrowhead(gen, el, points, 'end', el.endArrowhead);
        const text = label ? renderArrowLabel(el, label) : '';
        return { svg: `<g stroke-linecap="round">${defs}${shaft}${heads}${text}</g>` };
    },
    // The arrow label is the last plain-text path on the canvas.
    searchText: (el) => el.text,
});

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
