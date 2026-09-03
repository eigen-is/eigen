import type { Drawable, Options } from 'roughjs/bin/core';
import { RoughGenerator } from 'roughjs/bin/generator';
import { getFontFamily } from '../../constants/fonts';
import { headingIsHorizontal, vectorToHeading } from '../elbow-heading';
import { validateElbowPoints } from '../elbow-pins';
import { getLineHeightPx, getVerticalOffset } from '../font-metrics';
import {
    arrowheadGeometry,
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
    type Arrowhead,
    DEFAULT_ARROW_PROPS,
    DEFAULT_LINEAR_ROUNDNESS,
    DEFAULT_SKETCH_PROPS,
    type FixedSegment,
    parseBinding,
    parseFixedSegments,
    ROUNDNESS,
    serializeBinding,
    serializeFixedSegments,
    type VectorArrowElement,
} from '../types';
import { defineKind } from './kind';
import { bool, clampCoord, cleanStr, fontSize, MAX_COORD, num, oneOf, str } from './read-fields';
import { baseRoughOptions, drawableToSvg, escapeXml, round } from './render-utils';

export const arrowKind = defineKind<VectorArrowElement>({
    type: 'arrow',
    is: (el): el is VectorArrowElement => el.type === 'arrow',
    fields: [
        'roughness',
        'seed',
        'points',
        'roundness',
        'elbow',
        'fixedSegments',
        'startArrowhead',
        'endArrowhead',
        'startBinding',
        'endBinding',
        'text',
        'fontSize',
        'fontFamily',
        'labelWidth',
    ],
    capabilities: {
        fill: false,
        fillStyle: false,
        stroke: true,
        roughness: true,
        corners: false,
        opacity: true,
        typography: false,
        objectFit: false,
        arrowheads: true,
        bindable: false,
        silhouette: 'box',
        creation: 'polyline',
        resize: 'points',
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
        const clamped = points.map((p) => ({ x: clampCoord(p.x), y: clampCoord(p.y) }));
        const elbow = bool(src.get('elbow'), DEFAULT_ARROW_PROPS.elbow);
        return {
            ...base,
            type: 'arrow',
            // An elbow arrow's route is derived in the unrotated local frame, so it pins angle 0 (the
            // panel hides rotation for it) — the reader forces it regardless of what a peer stored.
            angle: elbow ? 0 : base.angle,
            roughness: num(src.get('roughness'), DEFAULT_SKETCH_PROPS.roughness),
            seed: num(src.get('seed'), DEFAULT_SKETCH_PROPS.seed),
            roundness: oneOf(src.get('roundness'), ROUNDNESS, DEFAULT_LINEAR_ROUNDNESS),
            points: serializePoints(clamped),
            elbow,
            // Pinned route segments live only on an elbow arrow — a straight arrow ignores them (its
            // route is the raw chord). Re-serialized through the canonical form: garbage and non
            // axis-aligned entries drop, coords clamp like the endpoints, '' when none remain.
            fixedSegments: elbow ? fixedSegments(src.get('fixedSegments'), clamped) : '',
            startArrowhead: oneOf(src.get('startArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.startArrowhead),
            endArrowhead: oneOf(src.get('endArrowhead'), ARROWHEADS, DEFAULT_ARROW_PROPS.endArrowhead),
            startBinding: binding(src.get('startBinding')),
            endBinding: binding(src.get('endBinding')),
            text: cleanStr(src.get('text'), DEFAULT_ARROW_PROPS.text),
            fontSize: fontSize(src.get('fontSize')),
            fontFamily: cleanStr(src.get('fontFamily'), DEFAULT_ARROW_PROPS.fontFamily),
            // Non-negative and capped at MAX_COORD like the spatial fields — a hostile 1e9 would
            // otherwise blow the shared viewBox (bounds unions the label rect) for every peer.
            labelWidth: Math.min(MAX_COORD, Math.max(0, num(src.get('labelWidth'), DEFAULT_ARROW_PROPS.labelWidth))),
        };
    },
    // An arrow unions its rotated label rect into the box bounds, so a wide label on a short arrow is not
    // clipped by the viewBox nor missed by marquee/ring. `route` (the derived elbow polyline) replaces the
    // stored box for an elbow arrow, whose bends spill outside the 2-endpoint box.
    bounds: (el, route): Bounds => {
        const box = route ? pointsBounds(route.map((p) => linearLocalToScene(el, p))) : getElementBounds(el);
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
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        return unionBounds(box, {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
        });
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
            const clipId = `arrow-label-clip-${el.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
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

// Ported from Excalidraw's generateElbowArrowShape (radius 16): each interior bend becomes an inset-before
// point, a quadratic control at the raw corner, and an inset-after point, so the corner rounds without moving
// the neighbouring vertices. The corner radius is min(16, half the shorter adjacent segment) so a short leg
// never over-rounds. The first and last route points — and thus the final segment's direction the head reads —
// are emitted verbatim. Full-precision numbers go to roughjs (like Excalidraw); rounding happens at serialize.
function elbowRoundedShaftPath(points: Point[]): string {
    const radius = 16;
    // Per interior bend: [insetBefore, corner, insetAfter], three points feeding one L + one Q.
    const sub: Point[] = [];
    for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const point = points[i];
        const next = points[i + 1];
        const corner = Math.min(radius, segmentLength(point, prev) / 2, segmentLength(point, next) / 2);
        sub.push(insetToward(point, prev, corner));
        sub.push(point);
        sub.push(insetToward(point, next, corner));
    }

    const first = points[0];
    const parts = [`M ${first.x} ${first.y}`];
    for (let i = 0; i < sub.length; i += 3) {
        parts.push(`L ${sub[i].x} ${sub[i].y}`);
        parts.push(`Q ${sub[i + 1].x} ${sub[i + 1].y}, ${sub[i + 2].x} ${sub[i + 2].y}`);
    }
    const last = points[points.length - 1];
    parts.push(`L ${last.x} ${last.y}`);
    return parts.join(' ');
}

// A point `corner` away from `point` along the (orthogonal) segment toward `neighbour`.
function insetToward(point: Point, neighbour: Point, corner: number): Point {
    if (headingIsHorizontal(vectorToHeading(point.x - neighbour.x, point.y - neighbour.y))) {
        return { x: neighbour.x < point.x ? point.x - corner : point.x + corner, y: point.y };
    }
    return { x: point.x, y: neighbour.y < point.y ? point.y - corner : point.y + corner };
}

function segmentLength(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// One arrowhead's roughjs fragment in the arrow's local frame. Barbs (arrow/bar/triangle) share the
// tip+base geometry: arrow = two lines, bar = one line through the tip, triangle = a solid polygon;
// circle = a solid disc. All filled solids use strokeColor. null when the head is 'none'.
function renderArrowhead(
    gen: RoughGenerator,
    el: VectorArrowElement,
    points: Point[],
    position: 'start' | 'end',
    head: Arrowhead,
): string {
    const geo = arrowheadGeometry(el, points, position, head);
    if (!geo) return '';
    if (geo.kind === 'circle') {
        return drawableToSvg(gen.circle(geo.center.x, geo.center.y, geo.diameter, headOptions(el, true, 0.5)));
    }
    if (head === 'triangle') {
        const options = headOptions(el, true, 1);
        return drawableToSvg(
            gen.polygon(
                [
                    [geo.barb1.x, geo.barb1.y],
                    [geo.tip.x, geo.tip.y],
                    [geo.barb2.x, geo.barb2.y],
                ],
                options,
            ),
        );
    }
    const options = headOptions(el, false, 1);
    if (head === 'bar') {
        return drawableToSvg(gen.line(geo.barb1.x, geo.barb1.y, geo.barb2.x, geo.barb2.y, options));
    }
    // 'arrow' — two barbs meeting at the tip
    return (
        drawableToSvg(gen.line(geo.barb1.x, geo.barb1.y, geo.tip.x, geo.tip.y, options)) +
        drawableToSvg(gen.line(geo.tip.x, geo.tip.y, geo.barb2.x, geo.barb2.y, options))
    );
}

// Head options mirror the shaft's (seed/stroke), preserveVertices on so a small head stays crisp, and cap
// roughness like Excalidraw's getArrowheadLineOptions — barbs at 1, the circle disc at 0.5 — so a rough head
// docks cleanly on the (now pinned) shaft end instead of forking off it. Solid heads (triangle/circle) fill
// with strokeColor.
function headOptions(el: VectorArrowElement, solidFill: boolean, roughnessCap: number): Options {
    const options = baseRoughOptions(el, true);
    options.roughness = Math.min(roughnessCap, options.roughness ?? 0);
    if (solidFill) {
        options.fillStyle = 'solid';
        options.fill = el.strokeColor;
    }
    return options;
}

// The even-odd clip hole under a label: an outer rect minus the label rect + 5px padding, both as
// rectangle subpaths of one path. Evenodd leaves the inner rect uncovered, so the shaft is cut there.
// The clip HIDES anything outside the outer rect, so it must enclose the whole shaft — the point bounds
// (and the hole) padded past roughjs jitter + the stroke half-width, never a fixed square (an arrow
// larger than it would lose its shaft).
function labelClipPath(
    points: Point[],
    label: { center: Point; width: number; height: number },
    strokeWidth: number,
): string {
    const pad = 5;
    const hx = label.center.x - label.width / 2 - pad;
    const hy = label.center.y - label.height / 2 - pad;
    const hw = label.width + pad * 2;
    const hh = label.height + pad * 2;

    let minX = hx;
    let minY = hy;
    let maxX = hx + hw;
    let maxY = hy + hh;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const margin = 50 + strokeWidth;
    const ox = round(minX - margin);
    const oy = round(minY - margin);
    const ow = round(maxX - minX + margin * 2);
    const oh = round(maxY - minY + margin * 2);

    const outer = `M${ox} ${oy} h${ow} v${oh} h${round(-ow)} Z`;
    const hole = `M${round(hx)} ${round(hy)} h${round(hw)} v${round(hh)} h${round(-hw)} Z`;
    return `<path clip-rule="evenodd" d="${outer} ${hole}"/>`;
}

// The label text, centered on the label rect in the arrow's local frame — the renderText baseline math
// with text-anchor="middle" and colour = strokeColor. Height/position come from arrowLabelBox.
function renderArrowLabel(el: VectorArrowElement, label: { center: Point; width: number; height: number }): string {
    const lineHeightPx = getLineHeightPx(el.fontFamily, el.fontSize);
    const verticalOffset = getVerticalOffset(el.fontFamily, el.fontSize, lineHeightPx);
    const fontFamily = escapeXml(getFontFamily(el.fontFamily));
    const fill = escapeXml(el.strokeColor);
    const lines = el.text.replace(/\r\n?/g, '\n').split('\n');
    const top = label.center.y - label.height / 2;
    const cx = round(label.center.x);

    let out = '';
    for (let i = 0; i < lines.length; i++) {
        const y = round(top + i * lineHeightPx + verticalOffset);
        out += `<text x="${cx}" y="${y}" font-family="${fontFamily}" font-size="${el.fontSize}px" fill="${fill}" text-anchor="middle" style="white-space: pre;">${escapeXml(lines[i])}</text>`;
    }
    return out;
}
