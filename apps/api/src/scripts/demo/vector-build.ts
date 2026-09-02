// Builds the site-plan drawing straight into a vector container's Y.Doc from the typed SITE_PLAN
// spec (content.ts) — the stickies-board approach without a fixture. Every element carries the same
// full field set an editor-authored element would (use-vector-doc's addElement), so the doc reads
// back through read-vector unchanged. Text is sized from the Excalifont metrics table because the
// seeder has no DOM to measure with. Deterministic ids + seeds: a reseed renders identical jitter.

import { basename } from 'node:path';
import {
    bindingAnchor,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_LINE_ROUNDNESS,
    DEFAULT_SHAPE_ROUNDNESS,
    ELEMENT_FIELDS,
    elbowBindPoint,
    followBindings,
    generateNKeysBetween,
    getLineHeightPx,
    normalizeLinear,
    type Point,
    serializeBinding,
    shapeSideMidpoints,
    type VectorArrowElement,
    type VectorElement,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorShapeElement,
    type VectorTextElement,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import type {
    SITE_PLAN,
    SitePlanArrow,
    SitePlanEnd,
    SitePlanImage,
    SitePlanLine,
    SitePlanShape,
    SitePlanSide,
    SitePlanText,
} from './content';
import { EXCALIFONT_ADVANCES, EXCALIFONT_KERNING } from './excalifont-metrics';

// Fixed PRNG salt so every reseed of the demo world draws the same roughjs seeds (identical jitter).
const SEED_SALT = 0x5170_2e73;
const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0, angle: 0 } as const;
const FONT = 'Excalifont';
const DEFAULT_LABEL_SIZE = 16;
const DEFAULT_ARROW_LABEL_SIZE = 13;

// Side-midpoint order matches shapeSideMidpoints (right, bottom, left, top).
const SIDE_INDEX: Record<'right' | 'bottom' | 'left' | 'top', number> = { right: 0, bottom: 1, left: 2, top: 3 };

// Unlisted glyphs fall back to the average advance (the metrics table's own note).
const AVG_ADVANCE =
    Object.values(EXCALIFONT_ADVANCES).reduce((sum, w) => sum + w, 0) / Object.keys(EXCALIFONT_ADVANCES).length;

// Client-parity text measurement: width = widest line's summed advances + kerning (em) × fontSize;
// height = lines × the font's line height. Mirrors the editor's text-measure so labels sit right.
export function measureExcalifont(text: string, fontSize: number): { width: number; height: number } {
    const lines = text.split('\n');
    let widest = 0;
    for (const line of lines) {
        const chars = [...line];
        let em = 0;
        for (let i = 0; i < chars.length; i++) {
            em += EXCALIFONT_ADVANCES[chars[i]] ?? AVG_ADVANCE;
            if (i > 0) em += EXCALIFONT_KERNING[chars[i - 1] + chars[i]] ?? 0;
        }
        if (em > widest) widest = em;
    }
    return { width: widest * fontSize, height: lines.length * getLineHeightPx(FONT, fontSize) };
}

// mulberry32 — a tiny deterministic PRNG, one draw per element (matches addElement's seed range).
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b_79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export function buildVectorDoc(doc: Y.Doc, plan: typeof SITE_PLAN): void {
    const shapes: VectorShapeElement[] = plan.shapes.map(buildShape);
    const byKey = new Map(plan.shapes.map((s, i) => [s.key, shapes[i]]));
    const byId = new Map<string, VectorElement>(shapes.map((s) => [s.id, s]));

    const lines: VectorLinearElement[] = plan.lines.map(buildLine);
    const images: VectorImageElement[] = plan.images.map(buildImage);
    const arrows: VectorArrowElement[] = plan.arrows.map((a, i) => buildArrow(a, i, byKey, byId));
    // Shape labels are texts drawn after the fills/images/arrows so they sit on top; free texts follow.
    const labels: VectorTextElement[] = plan.shapes
        .filter((s) => s.label !== '')
        .map((s) => buildLabel(s, byKey.get(s.key)!));
    const texts: VectorTextElement[] = plan.texts.map((t, i) => buildText(t, i));

    // Bottom-up z-order: ground lines, shapes, images, arrows, then every text on top.
    const ordered: VectorElement[] = [...lines, ...shapes, ...images, ...arrows, ...labels, ...texts];
    const keys = generateNKeysBetween(null, null, ordered.length);
    const seed = mulberry32(SEED_SALT);
    for (const [i, el] of ordered.entries()) {
        el.index = keys[i];
        el.seed = Math.floor(seed() * 2 ** 31);
    }

    // Every object is built with only ELEMENT_FIELDS keys, so a plain entries walk is the write
    // allow-list (the guard keeps that guarantee if the model ever grows a non-stored field).
    const allowed = new Set<string>(ELEMENT_FIELDS);
    doc.transact(() => {
        const map = doc.getMap('elements');
        for (const el of ordered) {
            const ym = new Y.Map();
            for (const [key, value] of Object.entries(el)) {
                if (value !== undefined && allowed.has(key)) ym.set(key, value);
            }
            map.set(el.id, ym);
        }
    });
}

function buildShape(s: SitePlanShape): VectorShapeElement {
    return {
        id: `el-${s.key}`,
        type: s.kind,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        angle: s.angle ?? 0,
        strokeColor: s.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: s.fill ?? DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: s.fillStyle ?? DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: s.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: s.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        roundness: s.roundness ?? DEFAULT_SHAPE_ROUNDNESS,
    };
}

function buildLine(l: SitePlanLine, i: number): VectorLinearElement {
    const points = l.points.map(([x, y]) => ({ x, y }));
    const norm = normalizeLinear(ZERO_BOX, points);
    return {
        id: `el-line-${i}`,
        type: l.freedraw ? 'freedraw' : 'line',
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: l.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: l.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: l.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        roundness: l.roundness ?? DEFAULT_LINE_ROUNDNESS,
        points: norm.points,
        pressures: '',
        simulatePressure: true,
    };
}

function buildImage(im: SitePlanImage, i: number): VectorImageElement {
    return {
        id: `el-image-${i}`,
        type: 'image',
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        angle: 0,
        strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        mediaName: basename(im.file),
    };
}

function buildArrow(
    a: SitePlanArrow,
    i: number,
    byKey: Map<string, VectorShapeElement>,
    byId: Map<string, VectorElement>,
): VectorArrowElement {
    const from = resolveEnd(a.from, a.elbow ?? false, byKey);
    const to = resolveEnd(a.to, a.elbow ?? false, byKey);
    const norm = normalizeLinear(ZERO_BOX, [from.point, to.point]);
    const fontSize = a.labelSize ?? DEFAULT_ARROW_LABEL_SIZE;
    const label = a.label ?? '';
    const arrow: VectorArrowElement = {
        id: `el-arrow-${i}`,
        type: 'arrow',
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: a.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: a.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        roundness: DEFAULT_ARROW_PROPS.roundness,
        points: norm.points,
        elbow: a.elbow ?? false,
        fixedSegments: '',
        startArrowhead: a.startHead ?? DEFAULT_ARROW_PROPS.startArrowhead,
        endArrowhead: a.endHead ?? DEFAULT_ARROW_PROPS.endArrowhead,
        startBinding: from.binding,
        endBinding: to.binding,
        text: label,
        fontSize,
        fontFamily: FONT,
        labelWidth: label ? measureExcalifont(label, fontSize).width : 0,
    };
    // Settle the endpoints exactly where the editor would at rest, then keep the patch when it moved.
    const patch = followBindings(arrow, byId);
    if (patch) {
        arrow.x = patch.x;
        arrow.y = patch.y;
        arrow.width = patch.width;
        arrow.height = patch.height;
        arrow.points = patch.points;
        arrow.fixedSegments = patch.fixedSegments;
    }
    return arrow;
}

// An arrow end: a real binding to a named shape's side midpoint, or a free scene point.
function resolveEnd(
    end: SitePlanEnd,
    elbow: boolean,
    byKey: Map<string, VectorShapeElement>,
): { point: Point; binding: string } {
    if ('at' in end) return { point: { x: end.at[0], y: end.at[1] }, binding: '' };
    const shape = byKey.get(end.shape);
    if (!shape) throw new Error(`site plan arrow binds to unknown shape ${end.shape}`);
    const dock = end.along === undefined ? shapeSideMidpoints(shape)[SIDE_INDEX[end.side]] : sidePoint(shape, end);
    const fixedPoint = elbow ? elbowBindPoint(shape, dock).fixedPoint : bindingAnchor(shape, dock);
    return { point: dock, binding: serializeBinding({ elementId: shape.id, fixedPoint }) };
}

// A point `along` (0..1) a rectangle's side, for docks that must not sit at the midpoint.
function sidePoint(shape: VectorShapeElement, end: { side: SitePlanSide; along?: number }): Point {
    const t = end.along ?? 0.5;
    switch (end.side) {
        case 'top':
            return { x: shape.x + shape.width * t, y: shape.y };
        case 'bottom':
            return { x: shape.x + shape.width * t, y: shape.y + shape.height };
        case 'left':
            return { x: shape.x, y: shape.y + shape.height * t };
        case 'right':
            return { x: shape.x + shape.width, y: shape.y + shape.height * t };
    }
}

function buildLabel(s: SitePlanShape, shape: VectorShapeElement): VectorTextElement {
    const fontSize = s.fontSize ?? DEFAULT_LABEL_SIZE;
    const { width, height } = measureExcalifont(s.label, fontSize);
    return {
        id: `el-${s.key}-label`,
        type: 'text',
        x: shape.x + shape.width / 2 - width / 2,
        y: shape.y + shape.height / 2 - height / 2,
        width,
        height,
        angle: shape.angle,
        strokeColor: DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        text: s.label,
        fontSize,
        fontFamily: FONT,
        textAlign: 'center',
    };
}

function buildText(t: SitePlanText, i: number): VectorTextElement {
    const { width, height } = measureExcalifont(t.text, t.fontSize);
    return {
        id: `el-text-${i}`,
        type: 'text',
        x: t.x,
        y: t.y,
        width,
        height,
        angle: 0,
        strokeColor: t.color ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        fillStyle: DEFAULT_ELEMENT_PROPS.fillStyle,
        strokeWidth: DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: DEFAULT_ELEMENT_PROPS.strokeStyle,
        roughness: DEFAULT_ELEMENT_PROPS.roughness,
        seed: 0,
        opacity: DEFAULT_ELEMENT_PROPS.opacity,
        locked: false,
        index: '',
        text: t.text,
        fontSize: t.fontSize,
        fontFamily: FONT,
        textAlign: 'left',
    };
}
