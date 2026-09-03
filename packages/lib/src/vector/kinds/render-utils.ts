// The roughjs/serializer bodies every drawing kind shares: option assembly, the Drawable → SVG
// serializer, and the two string helpers. Moved out of scene-to-svg.ts, which now only assembles the
// document; nothing here knows a kind beyond the fields it reads.

import type { Drawable, OpSet, Options } from 'roughjs/bin/core';
import { RoughGenerator } from 'roughjs/bin/generator';
import type { Fill } from '../../types/background';
import { isTransparentFill, parseFill } from '../fill';
import { isClosedPath, type Point } from '../geometry';
import { cornerRadius, roundedDiamondPath, roundedRectPath, sharpDiamondOffset } from '../outline';
import { isLinearElement, type VectorArrowElement, type VectorLinearElement, type VectorShapeElement } from '../types';

// A closed shape's rough drawing. Straight corners keep roughjs's own generators so the output is
// byte-identical to before; a rounded shape is the shared outline path — the same curve docking
// intersects. The generator is per-call: seeded roughjs output depends only on el.seed. The linecap
// rides the paths (the caller owns the placing <g>).
export function renderRoughShape(el: VectorShapeElement): string {
    const paths = drawableToSvg(shapeDrawable(new RoughGenerator(), el));
    return `<g stroke-linecap="round">${paths}</g>`;
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

function shapeDrawable(gen: RoughGenerator, el: VectorShapeElement): Drawable {
    if (el.type === 'ellipse') {
        return gen.ellipse(el.width / 2, el.height / 2, el.width, el.height, roughOptions(el, false));
    }
    const box = { x: 0, y: 0, width: el.width, height: el.height };
    const radius = cornerRadius(el, el.type);
    const rounded = radius > 0;
    const options = roughOptions(el, rounded);
    // Straight corners keep roughjs's own rectangle/polygon generators; a rounded one is the shared
    // outline path, the same curve docking intersects.
    if (!rounded) {
        if (el.type === 'rectangle') return gen.rectangle(0, 0, el.width, el.height, options);
        return gen.polygon(
            sharpDiamondOffset(box, 0).map((p): [number, number] => [p.x, p.y]),
            options,
        );
    }
    const d = el.type === 'rectangle' ? roundedRectPath(box, radius) : roundedDiamondPath(box, radius);
    return gen.path(d, options);
}

// Options assembly, replicated from Excalidraw's generateRoughOptions, minus the
// dark-mode filter. Determinism comes from the persisted per-element `seed`. The base fields are
// shared by shapes and linear elements; fill differs (shapes always, lines only when they loop).
export function baseRoughOptions(
    el: VectorShapeElement | VectorLinearElement | VectorArrowElement,
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

function roughOptions(el: VectorShapeElement, continuousPath: boolean): Options {
    const options = baseRoughOptions(el, continuousPath);
    options.fillStyle = el.fillStyle;
    options.fill = fillPaint(parseFill(el.fill));
    if (el.type === 'ellipse') options.curveFitting = 1;
    return options;
}

// roughjs paints one colour. A gradient paints as its first stop until the renderer emits a real
// <linearGradient>; transparent means no fill at all.
function fillPaint(fill: Fill): string | undefined {
    if (isTransparentFill(fill)) return undefined;
    return fill.type === 'solid' ? fill.color : fill.from;
}

// A line/freedraw fills only when its path loops (Excalidraw's generateRoughOptions line arm).
export function linearRoughOptions(el: VectorLinearElement, points: Point[]): Options {
    const options = baseRoughOptions(el, false);
    const fill = parseFill(el.fill);
    if (isClosedPath(points) && !isTransparentFill(fill)) {
        options.fillStyle = el.fillStyle;
        options.fill = fillPaint(fill);
    }
    return options;
}

// Reduce roughness for small elements so they don't look destroyed (Excalidraw's rule); a relatively
// long linear element is spared too, so a straight line doesn't wobble.
function adjustRoughness(el: VectorShapeElement | VectorLinearElement | VectorArrowElement): number {
    const maxSize = Math.max(el.width, el.height);
    const minSize = Math.min(el.width, el.height);
    const rounded = (el.type === 'rectangle' || el.type === 'diamond') && el.corners !== 'straight';
    const linear = isLinearElement(el);
    if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && rounded) || (linear && maxSize >= 50)) {
        return el.roughness;
    }
    return Math.min(el.roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

function dashArray(strokeStyle: VectorShapeElement['strokeStyle'], strokeWidth: number): number[] | undefined {
    if (strokeStyle === 'dashed') return [8, 8 + strokeWidth];
    if (strokeStyle === 'dotted') return [1.5, 6 + strokeWidth];
    return undefined;
}

// Fill sets come before the outline in `sets`, so drawing in order layers fill under stroke.
export function drawableToSvg(drawable: Drawable): string {
    const o = drawable.options;
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
            out += `<path d="${d}" stroke="${escapeXml(o.fill ?? 'none')}" stroke-width="${round(o.fillWeight)}" fill="none"/>`;
        }
    }
    return out;
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

export function round(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
}

export function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
