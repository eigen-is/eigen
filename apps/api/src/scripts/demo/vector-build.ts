// Builds the demo's site-plan drawing straight into a vector container's Y.Doc from the typed SITE_PLAN spec, with no
// stored file to keep up with the canvas's shape. Each element is built typed, because the arrows dock on the shapes
// before anything is written, and then goes through the editor's own writer, so the doc reads back unchanged. Text is
// sized with measureLabel, because the seeder has no DOM. Fixed ids and seeds make a reseed draw the same jitter.

import { basename } from 'node:path';
import { textToParagraphHtml } from '@workspace/lib/html';
import type {
    Point,
    StyleDefaults,
    VectorArrowElement,
    VectorElement,
    VectorElementBase,
    VectorElementType,
    VectorImageElement,
    VectorLinearElement,
    VectorRectangleElement,
    VectorShapeElement,
} from '@workspace/lib/vector';
import {
    baseDefaultsFor,
    bindingAnchor,
    DEFAULT_ARROW_PROPS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FILL_STYLE,
    DEFAULT_LINE_ROUNDNESS,
    DEFAULT_SHAPE_TEXT_PROPS,
    elbowBindPoint,
    followBindings,
    generateNKeysBetween,
    getFontMetrics,
    getLineHeightPx,
    kindDefaults,
    measureLabel,
    normalizeLinear,
    sceneBounds,
    serializeBinding,
    shapeAnchorPoints,
    solidFill,
    textBoxDefaults,
    textualDefaults,
    VECTOR_STYLE_DEFAULTS,
    writeElementInDoc,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type {
    CanvasSide,
    SITE_PLAN,
    SitePlanArrow,
    SitePlanEnd,
    SitePlanImage,
    SitePlanLine,
    SitePlanShape,
    SitePlanText,
} from './content';

// A fixed salt for the seed generator, so every reseed of the demo draws the same roughjs jitter.
const SEED_SALT = 0x5170_2e73;
const FONT = 'Excalifont';
// The Vector app's own style table with the drawing's font, as an element drawn in the editor gets it.
const SITE_PLAN_STYLE: StyleDefaults = { ...VECTOR_STYLE_DEFAULTS, fontFamily: FONT };
const DEFAULT_LABEL_SIZE = 16;
const DEFAULT_ARROW_LABEL_SIZE = 13;

// The width of the widest line, and the height of all lines at the font's line height.
function measureExcalifont(text: string, fontSize: number): { width: number; height: number } {
    const lines = text.split('\n');
    const width = Math.max(...lines.map((line) => measureLabel(line, FONT, fontSize, false)));
    return { width, height: lines.length * getLineHeightPx(FONT, fontSize) };
}

// The browser lays a text box out a little wider than the summed advances, so a one-line label at exactly the
// measured width wraps. 8% more keeps the demo's labels on one line. An arrow's label is SVG text, which never
// wraps, so it is measured without it.
const TEXT_BOX_SLACK = 1.08;

// The box a text box gets for a measured string: the measurement plus the shaping slack.
function measureTextBox(text: string, fontSize: number): { width: number; height: number } {
    const { width, height } = measureExcalifont(text, fontSize);
    return { width: width * TEXT_BOX_SLACK, height };
}

// The sides in shapeAnchorPoints' order.
const SIDE_INDEX: Record<CanvasSide, number> = { right: 0, bottom: 1, left: 2, top: 3 };

// normalizeLinear rebases a route onto its own bounds, so the box it starts from is empty.
const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0, angle: 0 } as const;

export function buildVectorDoc(doc: Y.Doc, plan: typeof SITE_PLAN): void {
    const shapes: VectorShapeElement[] = plan.shapes.map(buildShape);
    const byKey = new Map(plan.shapes.map((s, i) => [s.key, shapes[i]]));
    const byId = new Map<string, VectorElement>(shapes.map((s) => [s.id, s]));

    const lines: VectorLinearElement[] = plan.lines.map(buildLine);
    const images: VectorImageElement[] = plan.images.map(buildImage);
    const arrows: VectorArrowElement[] = plan.arrows.map((a, i) => buildArrow(a, i, byKey, byId));
    const texts: VectorRectangleElement[] = plan.texts.map((t, i) => buildText(t, i));

    // The z-order from the bottom: ground outlines, lines, shapes, images, arrows, and every text on top.
    const ground = shapes.filter((_, i) => plan.shapes[i].ground);
    const rest = shapes.filter((_, i) => !plan.shapes[i].ground);
    const ordered: VectorElement[] = [...ground, ...lines, ...rest, ...images, ...arrows, ...texts];
    const keys = generateNKeysBetween(null, null, ordered.length);
    const seed = mulberry32(SEED_SALT);
    for (const [i, el] of ordered.entries()) {
        el.index = keys[i];
        // One draw per element in z-order. The images and text boxes take theirs too, so every shape keeps the seed
        // it had. The range is randomSeed's, which starts at 1 because the reader reads a stored 0 as 1.
        el.seed = 1 + Math.floor(seed() * (2 ** 31 - 1));
    }

    // The spec is drawn from its own top left, and the editor opens on the scene's origin, so the drawing moves to
    // sit centered on it. Line points and binding anchors are relative to their element and move with it.
    const bounds = sceneBounds(ordered, new Map(ordered.map((el) => [el.id, el])));
    const dx = (bounds.minX + bounds.maxX) / 2;
    const dy = (bounds.minY + bounds.maxY) / 2;
    for (const el of ordered) {
        el.x -= dx;
        el.y -= dy;
    }

    doc.transact(() => {
        for (const el of ordered) writeElementInDoc(doc, el, el.index, SITE_PLAN_STYLE, el.id);
        doc.getMap('meta').set('background', plan.background);
    });
}

function buildShape(s: SitePlanShape): VectorShapeElement {
    const box = {
        ...baseElement(s.kind, `el-${s.key}`, SITE_PLAN_STYLE),
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        angle: s.angle ?? 0,
        strokeColor: s.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        strokeWidth: s.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: s.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        fill: solidFill(s.fill ?? 'transparent', s.fillStyle ?? DEFAULT_FILL_STYLE),
        // The label is the shape's own text, centered in it, so it moves and turns with the shape.
        ...textualDefaults(SITE_PLAN_STYLE, DEFAULT_SHAPE_TEXT_PROPS),
        html: s.label === '' ? '' : textToParagraphHtml(s.label),
        fontSize: s.fontSize ?? DEFAULT_LABEL_SIZE,
        lineHeight: getFontMetrics(FONT).lineHeight,
    };
    // An ellipse has no corners to treat, so it carries no `corners` field.
    if (s.kind === 'ellipse') return { ...box, type: 'ellipse' };
    const corners = s.corners ?? DEFAULT_CORNERS;
    if (s.kind === 'diamond') return { ...box, type: 'diamond', corners };
    return { ...box, type: 'rectangle', corners, autoFit: false };
}

function buildLine(l: SitePlanLine, i: number): VectorLinearElement {
    const points = l.points.map(([x, y]) => ({ x, y }));
    const norm = normalizeLinear(ZERO_BOX, points);
    return {
        ...baseElement(l.freedraw ? 'freedraw' : 'line', `el-line-${i}`, SITE_PLAN_STYLE),
        type: l.freedraw ? 'freedraw' : 'line',
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: l.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        strokeWidth: l.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: l.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        fill: solidFill('transparent'),
        roundness: l.roundness ?? DEFAULT_LINE_ROUNDNESS,
        points: norm.points,
        pressures: '',
        simulatePressure: true,
    };
}

function buildImage(im: SitePlanImage, i: number): VectorImageElement {
    return {
        ...kindDefaults('image', SITE_PLAN_STYLE),
        id: `el-image-${i}`,
        index: '',
        type: 'image',
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        angle: 0,
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
        ...baseElement('arrow', `el-arrow-${i}`, SITE_PLAN_STYLE),
        type: 'arrow',
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: a.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        strokeStyle: a.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
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
    // Settle a bound arrow's endpoints exactly where the editor would leave them at rest.
    const patch = followBindings(arrow, byId);
    if (!patch) return arrow;
    arrow.x = patch.x;
    arrow.y = patch.y;
    arrow.width = patch.width;
    arrow.height = patch.height;
    arrow.points = patch.points;
    arrow.fixedSegments = patch.fixedSegments;
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
    const dock = end.along === undefined ? shapeAnchorPoints(shape)[SIDE_INDEX[end.side]] : sidePoint(shape, end);
    const fixedPoint = elbow ? elbowBindPoint(shape, dock).fixedPoint : bindingAnchor(shape, dock);
    return { point: dock, binding: serializeBinding({ elementId: shape.id, fixedPoint }) };
}

// A point `along` (0..1) a rectangle's side, for docks that must not sit at the midpoint.
function sidePoint(shape: VectorShapeElement, end: { side: CanvasSide; along?: number }): Point {
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

// A free text, placed outside any shape: a text box's defaults under the drawing's style table, the box the seeder
// measured and the typography the drawing is authored in. Typed rather than partial, because sceneBounds measures it
// before the write.
function buildText(t: SitePlanText, i: number): VectorRectangleElement {
    const { width, height } = measureTextBox(t.text, t.fontSize);
    return {
        ...textBoxDefaults(SITE_PLAN_STYLE),
        id: `el-text-${i}`,
        index: '',
        type: 'rectangle',
        x: t.x,
        y: t.y,
        width,
        height,
        angle: 0,
        fontSize: t.fontSize,
        color: t.color ?? SITE_PLAN_STYLE.color,
        html: textToParagraphHtml(t.text),
        // The line height measureExcalifont sized the box with, so the text fills exactly that box.
        lineHeight: getFontMetrics(FONT).lineHeight,
    };
}

// The base every seeded element shares, from the table the apps create with. Each builder adds its kind's own
// fields.
function baseElement(
    type: VectorElementType,
    id: string,
    style: StyleDefaults,
): Omit<VectorElementBase, 'type' | 'x' | 'y' | 'width' | 'height' | 'angle'> {
    return { ...baseDefaultsFor(type, style), id, index: '' };
}

// mulberry32, a tiny seeded random number generator.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b_79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}
