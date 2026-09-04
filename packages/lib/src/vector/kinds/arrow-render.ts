// The arrow's drawing bodies: the rounded elbow shaft path, the arrowheads, the label's clip hole and
// the label text. Split from the kind because they are three times its size; nothing here reads a field
// the kind does not already own.

import type { Options } from 'roughjs/bin/core';
import type { RoughGenerator } from 'roughjs/bin/generator';
import { getFontFamily } from '../../constants/fonts';
import { escapeXml } from '../../core/html';
import { headingIsHorizontal, vectorToHeading } from '../elbow-heading';
import { getLineHeightPx, getVerticalOffset } from '../font-metrics';
import { arrowheadGeometry, type Point, round } from '../geometry';
import type { Arrowhead, VectorArrowElement } from '../types';
import { baseRoughOptions, drawableToSvg } from './render-utils';

// The label rect in the arrow's local frame, as arrowLabelBox returns it.
type LabelBox = { center: Point; width: number; height: number };

// Ported from Excalidraw's generateElbowArrowShape (radius 16): each interior bend becomes an inset-before
// point, a quadratic control at the raw corner, and an inset-after point, so the corner rounds without moving
// the neighbouring vertices. The corner radius is min(16, half the shorter adjacent segment) so a short leg
// never over-rounds. The first and last route points — and thus the final segment's direction the head reads —
// are emitted verbatim. Full-precision numbers go to roughjs (like Excalidraw); rounding happens at serialize.
export function elbowRoundedShaftPath(points: Point[]): string {
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
export function renderArrowhead(
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
export function labelClipPath(points: Point[], label: LabelBox, strokeWidth: number): string {
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
export function renderArrowLabel(el: VectorArrowElement, label: LabelBox): string {
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
