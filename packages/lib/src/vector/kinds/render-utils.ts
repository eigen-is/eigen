// The roughjs/serializer bodies every drawing kind shares: option assembly and the Drawable → SVG
// serializer. Nothing here knows a kind beyond the fields it reads.

import type { Drawable, OpSet, Options } from 'roughjs/bin/core';
import { RoughGenerator } from 'roughjs/bin/generator';
import { svgGradientStops } from '../../background/gradient';
import { getFontFamily } from '../../constants/fonts';
import { escapeXml } from '../../core/xml';
import { gradientVector, isTransparentColor, isTransparentFill, parseFill } from '../fill';
import { getLineHeightPx, getVerticalOffset } from '../font-metrics';
import type { Box, Point } from '../geometry';
import { arrowCurveBeziers, DEG_TO_RAD, isClosedPath, round } from '../geometry';
import {
    cornerRadius,
    diamondOutline,
    ellipseOutline,
    outlinePath,
    rectOutline,
    scaleNormalizedPath,
    sharpDiamondOffset,
} from '../outline';
import type {
    FillStyle,
    TextLine,
    VectorArrowElement,
    VectorElement,
    VectorImageElement,
    VectorLinearElement,
    VectorPathElement,
    VectorPieElement,
    VectorRichTextElement,
    VectorShapeElement,
} from '../types';
import { isLinearElement } from '../types';

// The SVG namespace, one spelling for every surface that writes it: the viewports scene-layers emits,
// the documents scene-to-svg serializes, a standalone chart and the live <svg> nodes the canvas mounts.
export const SVG_NS = 'http://www.w3.org/2000/svg';

// The most degrees of a slice's arc one cubic draws.
const ARC_PIECE = 45;

// Everything the fill paint needs: the stored Fill JSON plus the id its gradient def is scoped to.
type FillSource = { id: string; fill: string };

// What the one rough box drawable serves: the closed shapes, the pie slice and the path, plus the two DOM
// boxes whose border it is.
type RoughBoxElement =
    | VectorShapeElement
    | VectorPieElement
    | VectorPathElement
    | VectorImageElement
    | VectorRichTextElement;

// A closed box's rough drawing. The generator is per-call: seeded roughjs output depends only on
// el.seed. The linecap rides the paths (the caller owns the placing <g>).
export function renderRoughShape(el: RoughBoxElement): string {
    const outline = boxOutlinePath(el);
    const drawable = shapeDrawable(new RoughGenerator(), el, outline);
    // A gradient's defs ride along only when the fill paints.
    const defs = 'fill' in el && drawable.options.fill !== undefined ? fillDefs(el) : '';
    return `${defs}<g stroke-linecap="round">${drawableToSvg(drawable, { id: el.id, d: outline })}</g>`;
}

// The dashed box an element draws where its content can't be shown: a picture with no file, a chart that
// doesn't read.
export const PLACEHOLDER_STROKE = 'fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="6 6"';

// An element's own group: translated to its position, then rotated about its center (SVG rotate() takes
// degrees, as `angle` stores them). Every kind draws in its local frame inside one.
export function elementGroupOpen(el: VectorElement): string {
    const opacity = el.opacity !== 100 ? ` opacity="${round(el.opacity / 100)}"` : '';
    return `<g transform="${elementTransform(el)}"${opacity}>`;
}

function elementTransform(box: Box): string {
    const translate = `translate(${round(box.x)} ${round(box.y)})`;
    if (box.angle === 0) return translate;
    return `${translate} rotate(${round(box.angle)} ${round(box.width / 2)} ${round(box.height / 2)})`;
}

// One line of plain SVG text, which every surface draws (WeasyPrint ignores foreignObject). `y` is the
// line's top and the baseline sits the font's offset below it; a turned line turns about (x, y). Bold is
// 600, the weight of Inter's and JetBrains Mono's bundled bold faces; Source Serif's is 700, so its width
// table reserves slightly more than the line draws, and Excalifont has only a regular face.
export function svgTextLine({ text, x, y, anchor, fontFamily, fontSize, bold, color, rotate }: TextLine): string {
    const baseline = y + getVerticalOffset(fontFamily, fontSize, getLineHeightPx(fontFamily, fontSize));
    const turn = rotate === 0 ? '' : ` transform="rotate(${round(rotate)} ${round(x)} ${round(y)})"`;
    const weight = bold ? ' font-weight="600"' : '';
    return `<text x="${round(x)}" y="${round(baseline)}"${turn} font-family="${escapeXml(getFontFamily(fontFamily))}" font-size="${round(fontSize)}px"${weight} fill="${escapeXml(color)}" text-anchor="${anchor}" style="white-space: pre;">${escapeXml(text)}</text>`;
}

// Ported from Excalidraw's getFreeDrawSvgPath: a chain of quadratic segments whose control points are
// the outline vertices and whose on-curve points are the midpoints between them, closed with Z. Uses
// our round() (2 decimals) in place of Excalidraw's TO_FIXED_PRECISION regex.
export function getSvgPathFromStroke(points: number[][]): string {
    if (points.length === 0) return '';
    const max = points.length - 1;
    const parts: (number[] | string)[] = ['M', points[0], 'Q'];
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (i === max) parts.push(point, med(point, points[0]), 'L', points[0], 'Z');
        else parts.push(point, med(point, points[i + 1]));
    }
    return parts.map((part) => (typeof part === 'string' ? part : `${round(part[0])} ${round(part[1])}`)).join(' ');
}

function med(a: number[], b: number[]): number[] {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// The box's own outline in its local frame: what a slice, a path and a rounded corner draw through gen.path, and what
// every hatch is clipped to.
function boxOutlinePath(el: RoughBoxElement): string {
    const box = { x: 0, y: 0, width: el.width, height: el.height };
    if (el.type === 'ellipse' || isWholeSlice(el)) return outlinePath(ellipseOutline(box, 0));
    // A slice is SVG arcs, as a rounded corner is: roughjs's own arc samples 20° steps at any size and leads in
    // from inside the rim, which facets a large slice. roughjs draws an arc as one cubic per up to 120°, which
    // bulges 0.15% of the radius; one per ARC_PIECE bulges as little as its ellipse.
    if (el.type === 'pie') {
        const rx = el.width / 2;
        const ry = el.height / 2;
        const rim = (deg: number) =>
            `${round(rx + rx * Math.cos(deg * DEG_TO_RAD))} ${round(ry + ry * Math.sin(deg * DEG_TO_RAD))}`;
        const pieces = Math.ceil(el.sweepAngle / ARC_PIECE);
        let d = `M ${round(rx)} ${round(ry)} L ${rim(el.startAngle)}`;
        for (let i = 1; i <= pieces; i++) {
            d += ` A ${round(rx)} ${round(ry)} 0 0 1 ${rim(el.startAngle + (el.sweepAngle * i) / pieces)}`;
        }
        return `${d} Z`;
    }
    // A path is its own SVG path, scaled from the unit box.
    if (el.type === 'path') return scaleNormalizedPath(el.path, el.width, el.height);
    if (el.type === 'diamond') return outlinePath(diamondOutline(box, cornerRadius(el, 'diamond'), 0));
    return outlinePath(rectOutline(box, cornerRadius(el, 'rectangle'), 0));
}

// A whole slice is the ellipse: a slice's path would draw its two radii as a seam.
function isWholeSlice(el: RoughBoxElement): boolean {
    return el.type === 'pie' && el.sweepAngle >= 360;
}

function shapeDrawable(gen: RoughGenerator, el: RoughBoxElement, outline: string): Drawable {
    if (el.type === 'ellipse' || isWholeSlice(el)) {
        return gen.ellipse(el.width / 2, el.height / 2, el.width, el.height, roughOptions(el, false));
    }
    if (el.type === 'pie') return gen.path(outline, roughOptions(el, true));
    if (el.type === 'path') return gen.path(outline, roughOptions(el, el.closed));
    const rounded = cornerRadius(el, el.type === 'diamond' ? 'diamond' : 'rectangle') > 0;
    const options = roughOptions(el, rounded);
    // Straight corners keep roughjs's own rectangle/polygon generators; a rounded one is the shared
    // outline path, the same curve docking intersects.
    if (rounded) return gen.path(outline, options);
    if (el.type !== 'diamond') return gen.rectangle(0, 0, el.width, el.height, options);
    const box = { x: 0, y: 0, width: el.width, height: el.height };
    return gen.polygon(
        sharpDiamondOffset(box, 0).map((p): [number, number] => [p.x, p.y]),
        options,
    );
}

// Options assembly, replicated from Excalidraw's generateRoughOptions, minus the
// dark-mode filter. Determinism comes from the persisted per-element `seed`. The base fields are shared
// by every rough element — boxes (shapes, image, rich text) and linear ones; fill differs (a box that
// carries one always, lines only when they loop).
export function baseRoughOptions(
    el: RoughBoxElement | VectorLinearElement | VectorArrowElement,
    continuousPath: boolean,
): Options {
    return {
        seed: el.seed,
        strokeLineDash: dashArray(el.strokeStyle, el.strokeWidth),
        disableMultiStroke: el.strokeStyle !== 'solid',
        // non-solid strokes disable multiStroke, so widen a touch to match solid weight
        strokeWidth: el.strokeStyle !== 'solid' ? el.strokeWidth + 0.5 : el.strokeWidth,
        // set fill tuning explicitly so rough doesn't re-derive it from strokeWidth
        fillWeight: el.strokeWidth / 2,
        hachureGap: el.strokeWidth * 4,
        roughness: adjustRoughness(el),
        stroke: el.strokeColor,
        // Deliberate drift from Excalidraw (crisper): a line/arrow SHAFT preserves its vertices at every
        // roughness, so cartoon-roughness (r≥2) endpoints sit exactly on the stored points instead of
        // wandering ~3px off. Shapes keep Excalidraw's roughness<2 rule; freedraw's roughjs FILL is
        // untouched (its stroke is perfect-freehand, never roughjs).
        preserveVertices: continuousPath || el.roughness < 2 || el.type === 'line' || el.type === 'arrow',
    };
}

function roughOptions(el: RoughBoxElement, continuousPath: boolean): Options {
    const options = baseRoughOptions(el, continuousPath);
    // A shape with its border switched off (capabilities.strokeOptional): roughjs's own 'none' skips
    // the outline sets entirely, so the fill still paints and no invisible path is serialized.
    if (isTransparentColor(el.strokeColor)) options.stroke = 'none';
    // An image carries no Fill at all and an open path has nothing to fill: roughjs then draws the
    // outline alone.
    if ('fill' in el && (el.type !== 'path' || el.closed)) {
        const { fill, fillStyle } = fillOptions(el);
        options.fill = fill;
        options.fillStyle = fillStyle;
    }
    if (el.type === 'ellipse' || el.type === 'pie') options.curveFitting = 1;
    return options;
}

// A gradient is one <linearGradient> in the element's OWN <defs>, referenced by the paths beside it:
// WeasyPrint renders nothing for a url(#…) into a different <svg>. Ids are element-scoped, so many
// fragments on one page never collide.
export function fillDefs(el: FillSource): string {
    const fill = parseFill(el.fill);
    if (fill.type !== 'gradient') return '';
    const { x1, y1, x2, y2 } = gradientVector(fill.angle);
    return `<defs><linearGradient id="${svgId('fill', el.id)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${svgGradientStops(fill.from, fill.to)}</linearGradient></defs>`;
}

// The stored Fill as roughjs options: what to paint with, and the hatch style it carries. drawableToSvg
// copies the paint into `fill=` on fillPath sets and `stroke=` on the fillSketch sets hachure/cross-hatch/
// zigzag emit, which is what a gradient needs on both. The stroke proper stays a solid color.
// `fill: undefined` (a transparent paint) leaves roughjs drawing the outline alone.
function fillOptions(el: FillSource): { fill: string | undefined; fillStyle: FillStyle } {
    const fill = parseFill(el.fill);
    return {
        fill: isTransparentFill(fill)
            ? undefined
            : fill.type === 'solid'
              ? fill.color
              : `url(#${svgId('fill', el.id)})`,
        fillStyle: fill.style,
    };
}

// A document-unique SVG id for one element's own defs. Every character outside the id-safe set is
// hex-ESCAPED, not stripped: a hostile element id can neither escape the attribute nor collapse onto
// another element's id and paint its gradient.
export function svgId(prefix: string, elementId: string): string {
    return `${prefix}-${elementId.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}

// A line/freedraw fills only when its path loops (Excalidraw's generateRoughOptions line arm).
export function linearRoughOptions(el: VectorLinearElement, points: Point[]): Options {
    const options = baseRoughOptions(el, false);
    const { fill, fillStyle } = fillOptions(el);
    if (isClosedPath(points) && fill !== undefined) {
        options.fill = fill;
        options.fillStyle = fillStyle;
    }
    return options;
}

// Reduce roughness for small elements so they don't look destroyed (Excalidraw's rule); a relatively
// long linear element is spared too, so a straight line doesn't wobble.
function adjustRoughness(el: RoughBoxElement | VectorLinearElement | VectorArrowElement): number {
    const maxSize = Math.max(el.width, el.height);
    const minSize = Math.min(el.width, el.height);
    const rounded = 'corners' in el && el.corners !== 'straight';
    const linear = isLinearElement(el);
    if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && rounded) || (linear && maxSize >= 50)) {
        return el.roughness;
    }
    return Math.min(el.roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

// The DOM-box kinds (image, rich text) use the stroke fields as a BORDER rather than a drawn outline,
// so "does this one paint a border" is one predicate, not a repeated pair of tests.
export function isBordered(el: { strokeWidth: number; strokeColor: string }): boolean {
    return el.strokeWidth > 0 && !isTransparentColor(el.strokeColor);
}

// Neither a painted fill nor a painted stroke: the element's own paint puts no ink on the page. The
// shared half of a kind's `paintsNothing` — rich text adds "and no text", an image "and no picture".
export function isUnpainted(el: { fill: string; strokeWidth: number; strokeColor: string }): boolean {
    return !isBordered(el) && isTransparentFill(parseFill(el.fill));
}

// The stroke-style vocabulary as roughjs `strokeLineDash`: one dash table behind every stroke roughjs
// draws, the DOM boxes' borders included.
function dashArray(strokeStyle: VectorShapeElement['strokeStyle'], strokeWidth: number): number[] | undefined {
    if (strokeStyle === 'dashed') return [8, 8 + strokeWidth];
    if (strokeStyle === 'dotted') return [1.5, 6 + strokeWidth];
    return undefined;
}

// A hatch's clip: the outline it fills and the element its clipPath id is scoped to. roughjs strokes hachure,
// cross-hatch and zigzag past the shape (a zigzag by about 3px at any size), which shows on a small one, so the
// strokes draw inside the outline and the outline itself stays unclipped. A solid fill is the outline already.
export type HatchClip = { id: string; d: string };

// Fill sets come before the outline in `sets`, so drawing in order layers fill under stroke.
export function drawableToSvg(drawable: Drawable, clip?: HatchClip): string {
    const o = drawable.options;
    let hatch = '';
    let out = '';
    for (const set of drawable.sets) {
        const d = opsToPath(set);
        if (!d) continue;
        if (set.type === 'path') {
            const dash = o.strokeLineDash?.length ? ` stroke-dasharray="${o.strokeLineDash.map(round).join(' ')}"` : '';
            out += `<path d="${d}" stroke="${escapeXml(o.stroke)}" stroke-width="${round(o.strokeWidth)}" fill="none"${dash}/>`;
        } else if (set.type === 'fillPath') {
            out += `<path d="${d}" fill="${escapeXml(o.fill ?? 'none')}" stroke="none"/>`;
        } else if (set.type === 'fillSketch') {
            hatch += `<path d="${d}" stroke="${escapeXml(o.fill ?? 'none')}" stroke-width="${round(o.fillWeight)}" fill="none"/>`;
        }
    }
    if (hatch === '' || !clip?.d) return hatch + out;
    const id = svgId('hatch', clip.id);
    return `<defs><clipPath id="${id}"><path d="${clip.d}"/></clipPath></defs><g clip-path="url(#${id})">${hatch}</g>${out}`;
}

// A closed line's outline, which its hatch is clipped to: the polygon, or a round line's curve as roughjs draws it.
export function loopPath(points: Point[], curved: boolean): string {
    if (!curved || points.length < 2) return outlinePath({ kind: 'polygon', corners: points });
    const at = (p: Point) => `${round(p.x)} ${round(p.y)}`;
    const curves = arrowCurveBeziers(points).map(([, c1, c2, end]) => `C ${at(c1)} ${at(c2)} ${at(end)}`);
    return `M ${at(points[0])} ${curves.join(' ')} Z`;
}

// The whole roughjs serializer: move→M, lineTo→L, bcurveTo→C, coordinates to 2 decimals.
function opsToPath(opset: OpSet): string {
    const parts: string[] = [];
    for (const { op, data } of opset.ops) {
        if (op === 'move') parts.push(`M${round(data[0])} ${round(data[1])}`);
        else if (op === 'lineTo') parts.push(`L${round(data[0])} ${round(data[1])}`);
        else if (op === 'bcurveTo')
            parts.push(
                `C${round(data[0])} ${round(data[1])} ${round(data[2])} ${round(data[3])} ${round(data[4])} ${round(data[5])}`,
            );
    }
    return parts.join(' ');
}
