// Pure scene → SVG string. No DOM, no measurement: roughjs's RoughGenerator yields path
// ops as plain data (DOM-free), we serialize them ourselves (SCOUT §3, replacing RoughSVG),
// and text trusts client-measured width/height so the server never measures. Shared verbatim
// by the frontend (previews/embeds/thumbnails/export) and the API transform Worker.

import type { Drawable, OpSet, Options } from 'roughjs/bin/core';
import { RoughGenerator } from 'roughjs/bin/generator';
import { getFontFamily } from '../constants/fonts';
import { getLineHeightPx, getVerticalOffset } from './font-metrics';
import { orderByFractionalIndex } from './fractional-index';
import type { Box } from './geometry';
import { getElementsBounds } from './geometry';
import {
    isTransparent,
    type VectorElement,
    type VectorImageElement,
    type VectorScene,
    type VectorShapeElement,
    type VectorTextElement,
} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_PADDING = 10;

// Radius policy — a renderer constant, never stored (CONTRACT RULING 6). Rectangles use
// Excalidraw's ADAPTIVE radius (cap 32), diamonds the PROPORTIONAL radius (0.25).
const PROPORTIONAL_RADIUS = 0.25;
const ADAPTIVE_RADIUS = 32;

// Resolve an image element's media reference to an <image> href (data: URI or URL). The
// host (FE/BE) supplies it; unresolvable media renders nothing.
export type MediaResolver = (mediaName: string) => string | null;

export type SceneToSvgOptions = {
    resolveMedia?: MediaResolver;
    padding?: number;
};

export function sceneToSvg(scene: VectorScene, opts: SceneToSvgOptions = {}): string {
    const ordered = orderByFractionalIndex(scene.elements);
    if (ordered.length === 0) {
        return `<svg xmlns="${SVG_NS}" width="0" height="0" viewBox="0 0 0 0"></svg>`;
    }

    const padding = opts.padding ?? DEFAULT_PADDING;
    const bounds = getElementsBounds(ordered);
    const minX = round(bounds.minX - padding);
    const minY = round(bounds.minY - padding);
    const width = round(bounds.maxX - bounds.minX + padding * 2);
    const height = round(bounds.maxY - bounds.minY + padding * 2);

    let body = '';
    if (!isTransparent(scene.meta.background)) {
        body += `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${escapeXml(scene.meta.background)}"/>`;
    }
    for (const el of ordered) {
        body += elementToSvg(el, opts);
    }

    return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">${body}</svg>`;
}

// One element → its own SVG fragment (a `<g>`), the exact per-element code path sceneToSvg
// runs. The live canvas (packages/ui) reuses this so its per-element nodes are byte-for-byte
// what previews/embeds/export produce. Shapes get a fresh RoughGenerator — seeded roughjs
// output depends only on el.seed, not generator identity, so the golden output is unchanged.
export function elementToSvg(el: VectorElement, opts: SceneToSvgOptions = {}): string {
    switch (el.type) {
        case 'rectangle':
        case 'diamond':
        case 'ellipse':
            return renderShape(new RoughGenerator(), el);
        case 'text':
            return renderText(el);
        case 'image':
            return renderImage(el, opts);
    }
}

function renderShape(gen: RoughGenerator, el: VectorShapeElement): string {
    const paths = drawableToSvg(shapeDrawable(gen, el));
    return `${groupOpen(el, ' stroke-linecap="round"')}${paths}</g>`;
}

function renderText(el: VectorTextElement): string {
    const lineHeightPx = getLineHeightPx(el.fontFamily, el.fontSize);
    const verticalOffset = getVerticalOffset(el.fontFamily, el.fontSize, lineHeightPx);
    const anchor = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
    const hx = el.textAlign === 'center' ? el.width / 2 : el.textAlign === 'right' ? el.width : 0;
    const fontFamily = escapeXml(getFontFamily(el.fontFamily));
    const fill = escapeXml(el.strokeColor);
    const lines = el.text.replace(/\r\n?/g, '\n').split('\n');

    let out = groupOpen(el);
    for (let i = 0; i < lines.length; i++) {
        const y = round(i * lineHeightPx + verticalOffset);
        out += `<text x="${round(hx)}" y="${y}" font-family="${fontFamily}" font-size="${el.fontSize}px" fill="${fill}" text-anchor="${anchor}" style="white-space: pre;" dominant-baseline="alphabetic">${escapeXml(lines[i])}</text>`;
    }
    return `${out}</g>`;
}

function renderImage(el: VectorImageElement, opts: SceneToSvgOptions): string {
    const href = opts.resolveMedia?.(el.mediaName) ?? null;
    if (!href) return '';
    return `${groupOpen(el)}<image x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" href="${escapeXml(href)}" preserveAspectRatio="none"/></g>`;
}

// translate to the element's position, then rotate about its center (angle in degrees →
// SVG rotate() takes degrees directly, no conversion — CONTRACT RULING 1).
function elementTransform(box: Box): string {
    const translate = `translate(${round(box.x)} ${round(box.y)})`;
    if (box.angle === 0) return translate;
    return `${translate} rotate(${round(box.angle)} ${round(box.width / 2)} ${round(box.height / 2)})`;
}

function groupOpen(el: VectorElement, extra = ''): string {
    const opacity = el.opacity !== 100 ? ` opacity="${round(el.opacity / 100)}"` : '';
    return `<g transform="${elementTransform(el)}"${extra}${opacity}>`;
}

function shapeDrawable(gen: RoughGenerator, el: VectorShapeElement): Drawable {
    const rounded = el.roundness === 'round' && (el.type === 'rectangle' || el.type === 'diamond');
    const options = roughOptions(el, rounded);

    if (el.type === 'rectangle') {
        if (!rounded) return gen.rectangle(0, 0, el.width, el.height, options);
        const w = el.width;
        const h = el.height;
        const r = adaptiveCornerRadius(Math.min(w, h));
        const d = `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`;
        return gen.path(d, options);
    }

    if (el.type === 'diamond') {
        const p = diamondPoints(el.width, el.height);
        if (!rounded) {
            return gen.polygon(
                [
                    [p.topX, p.topY],
                    [p.rightX, p.rightY],
                    [p.bottomX, p.bottomY],
                    [p.leftX, p.leftY],
                ],
                options,
            );
        }
        const vr = Math.abs(p.topX - p.leftX) * PROPORTIONAL_RADIUS;
        const hr = Math.abs(p.rightY - p.topY) * PROPORTIONAL_RADIUS;
        const d = `M ${p.topX + vr} ${p.topY + hr} L ${p.rightX - vr} ${p.rightY - hr} C ${p.rightX} ${p.rightY}, ${p.rightX} ${p.rightY}, ${p.rightX - vr} ${p.rightY + hr} L ${p.bottomX + vr} ${p.bottomY - hr} C ${p.bottomX} ${p.bottomY}, ${p.bottomX} ${p.bottomY}, ${p.bottomX - vr} ${p.bottomY - hr} L ${p.leftX + vr} ${p.leftY + hr} C ${p.leftX} ${p.leftY}, ${p.leftX} ${p.leftY}, ${p.leftX + vr} ${p.leftY - hr} L ${p.topX - vr} ${p.topY + hr} C ${p.topX} ${p.topY}, ${p.topX} ${p.topY}, ${p.topX + vr} ${p.topY + hr}`;
        return gen.path(d, options);
    }

    // ellipse — center at (w/2, h/2), full width/height as diameters, plus curveFitting:1
    return gen.ellipse(el.width / 2, el.height / 2, el.width, el.height, options);
}

// Options assembly, replicated from Excalidraw's generateRoughOptions (SCOUT §1), minus the
// dark-mode filter. Determinism comes from the persisted per-element `seed`.
function roughOptions(el: VectorShapeElement, continuousPath: boolean): Options {
    const options: Options = {
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
        preserveVertices: continuousPath || el.roughness < 2,
        fillStyle: el.fillStyle,
        fill: isTransparent(el.backgroundColor) ? undefined : el.backgroundColor,
    };
    if (el.type === 'ellipse') options.curveFitting = 1;
    return options;
}

// Reduce roughness for small elements so they don't look destroyed (SCOUT §1).
function adjustRoughness(el: VectorShapeElement): number {
    const maxSize = Math.max(el.width, el.height);
    const minSize = Math.min(el.width, el.height);
    const roundable = el.type === 'rectangle' || el.type === 'diamond';
    if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && el.roundness === 'round' && roundable)) {
        return el.roughness;
    }
    return Math.min(el.roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

function dashArray(strokeStyle: VectorShapeElement['strokeStyle'], strokeWidth: number): number[] | undefined {
    if (strokeStyle === 'dashed') return [8, 8 + strokeWidth];
    if (strokeStyle === 'dotted') return [1.5, 6 + strokeWidth];
    return undefined;
}

function adaptiveCornerRadius(x: number): number {
    const cutoff = ADAPTIVE_RADIUS / PROPORTIONAL_RADIUS;
    return x <= cutoff ? x * PROPORTIONAL_RADIUS : ADAPTIVE_RADIUS;
}

// +1 avoids zero-length sides that make rough throw (Excalidraw's getDiamondPoints).
function diamondPoints(width: number, height: number) {
    const topX = Math.floor(width / 2) + 1;
    const rightY = Math.floor(height / 2) + 1;
    return {
        topX,
        topY: 0,
        rightX: width,
        rightY,
        bottomX: topX,
        bottomY: height,
        leftX: 0,
        leftY: rightY,
    };
}

// Fill sets come before the outline in `sets`, so drawing in order layers fill under stroke.
function drawableToSvg(drawable: Drawable): string {
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

function round(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
