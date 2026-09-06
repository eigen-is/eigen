// Builds the site-plan drawing straight into a vector container's Y.Doc from the typed SITE_PLAN
// spec (content.ts) — the stickies-board approach without a fixture. Every element carries the same
// full field set an editor-authored element would (use-canvas-doc's addElement), so the doc reads
// back through read-vector unchanged. Text is sized from the Excalifont metrics table because the
// seeder has no DOM to measure with. Deterministic ids + seeds: a reseed renders identical jitter.

import { basename } from 'node:path';
import { textToParagraphHtml } from '@workspace/lib/html';
import {
    bindingAnchor,
    DEFAULT_ARROW_PROPS,
    DEFAULT_CORNERS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FILL_STYLE,
    DEFAULT_LINE_ROUNDNESS,
    DEFAULT_SKETCH_PROPS,
    ELEMENT_FIELDS,
    elbowBindPoint,
    generateNKeysBetween,
    getFontMetrics,
    getLineHeightPx,
    normalizeLinear,
    type Point,
    type StyleDefaults,
    sceneBounds,
    serializeBinding,
    shapeAnchorPoints,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
    type VectorArrowElement,
    type VectorElement,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorRichTextElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import {
    baseElement,
    type CanvasSide,
    imageElement,
    mulberry32,
    richTextElement,
    SIDE_INDEX,
    settleEndpoints,
    toYMap,
    ZERO_BOX,
} from './canvas-build';
import type {
    SITE_PLAN,
    SitePlanArrow,
    SitePlanEnd,
    SitePlanImage,
    SitePlanLine,
    SitePlanShape,
    SitePlanText,
} from './content';
import { EXCALIFONT_ADVANCES, EXCALIFONT_KERNING } from './excalifont-metrics';

// Fixed PRNG salt so every reseed of the demo world draws the same roughjs seeds (identical jitter).
const SEED_SALT = 0x5170_2e73;
const FONT = 'Excalifont';
// The vector app's own style table, with the drawing's font — what an editor-authored element inherits.
const SITE_PLAN_STYLE: StyleDefaults = { ...VECTOR_STYLE_DEFAULTS, fontFamily: FONT };
const DEFAULT_LABEL_SIZE = 16;
const DEFAULT_ARROW_LABEL_SIZE = 13;

// Unlisted glyphs fall back to the average advance (the metrics table's own note).
const AVG_ADVANCE =
    Object.values(EXCALIFONT_ADVANCES).reduce((sum, w) => sum + w, 0) / Object.keys(EXCALIFONT_ADVANCES).length;

// Client-parity text measurement: width = widest line's summed advances + kerning (em) × fontSize;
// height = lines × the font's line height. Mirrors the editor's text-measure so labels sit right.
function measureExcalifont(text: string, fontSize: number): { width: number; height: number } {
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

// A rich-text box is laid out by the browser's HTML shaper, which runs a little wider than this
// advance table; at exactly the measured width a one-line label wraps. 8% slack keeps the demo's
// labels on one line. Arrow labels are SVG <text> (no wrapping), so they measure unpadded.
const RICH_TEXT_SLACK = 1.08;

// The box a rich-text element gets for a measured string: the measurement plus the shaping slack.
function measureRichTextBox(text: string, fontSize: number): { width: number; height: number } {
    const { width, height } = measureExcalifont(text, fontSize);
    return { width: width * RICH_TEXT_SLACK, height };
}

export function buildVectorDoc(doc: Y.Doc, plan: typeof SITE_PLAN): void {
    const shapes: VectorShapeElement[] = plan.shapes.map(buildShape);
    const byKey = new Map(plan.shapes.map((s, i) => [s.key, shapes[i]]));
    const byId = new Map<string, VectorElement>(shapes.map((s) => [s.id, s]));

    const lines: VectorLinearElement[] = plan.lines.map(buildLine);
    const images: VectorImageElement[] = plan.images.map(buildImage);
    const arrows: VectorArrowElement[] = plan.arrows.map((a, i) => buildArrow(a, i, byKey, byId));
    // Shape labels are rich text drawn after the fills/images/arrows so they sit on top; free texts follow.
    const labels: VectorRichTextElement[] = plan.shapes.flatMap((s, i) =>
        s.label === '' ? [] : [buildLabel(s, shapes[i])],
    );
    const texts: VectorRichTextElement[] = plan.texts.map((t, i) => buildText(t, i));

    // Bottom-up z-order: ground outlines, lines, shapes, images, arrows, then every text on top.
    const ground = shapes.filter((_, i) => plan.shapes[i].ground);
    const rest = shapes.filter((_, i) => !plan.shapes[i].ground);
    const ordered: VectorElement[] = [...ground, ...lines, ...rest, ...images, ...arrows, ...labels, ...texts];
    const keys = generateNKeysBetween(null, null, ordered.length);
    const seed = mulberry32(SEED_SALT);
    for (const [i, el] of ordered.entries()) {
        el.index = keys[i];
        // One draw per element either way, so adding an unsketched kind never shifts the others' jitter.
        const drawn = Math.floor(seed() * 2 ** 31);
        if ('seed' in el) el.seed = drawn;
    }

    // The spec is authored in its own top-left frame; the editor opens on the scene origin, so shift the
    // drawing to sit centred on it. Linear points and binding anchors are element-relative and ride along.
    const bounds = sceneBounds(ordered, new Map(ordered.map((el) => [el.id, el])));
    const dx = (bounds.minX + bounds.maxX) / 2;
    const dy = (bounds.minY + bounds.maxY) / 2;
    for (const el of ordered) {
        el.x -= dx;
        el.y -= dy;
    }

    doc.transact(() => {
        const map = doc.getMap('elements');
        for (const el of ordered) map.set(el.id, toYMap(el, ELEMENT_FIELDS));
        doc.getMap('meta').set('background', plan.background);
    });
}

function buildShape(s: SitePlanShape): VectorShapeElement {
    const box = {
        ...baseElement(s.kind, `el-${s.key}`),
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        angle: s.angle ?? 0,
        strokeColor: s.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        strokeWidth: s.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
        strokeStyle: s.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        fill: solidFill(s.fill ?? 'transparent', s.fillStyle ?? DEFAULT_FILL_STYLE),
        ...DEFAULT_SKETCH_PROPS,
    };
    // An ellipse has no corners to treat, so it carries no `corners` field.
    if (s.kind === 'ellipse') return { ...box, type: 'ellipse' };
    const corners = s.corners ?? DEFAULT_CORNERS;
    if (s.kind === 'diamond') return { ...box, type: 'diamond', corners };
    return { ...box, type: 'rectangle', corners };
}

function buildLine(l: SitePlanLine, i: number): VectorLinearElement {
    const points = l.points.map(([x, y]) => ({ x, y }));
    const norm = normalizeLinear(ZERO_BOX, points);
    return {
        ...baseElement(l.freedraw ? 'freedraw' : 'line', `el-line-${i}`),
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
        ...DEFAULT_SKETCH_PROPS,
        roundness: l.roundness ?? DEFAULT_LINE_ROUNDNESS,
        points: norm.points,
        pressures: '',
        simulatePressure: true,
    };
}

function buildImage(im: SitePlanImage, i: number): VectorImageElement {
    return imageElement(`el-image-${i}`, SITE_PLAN_STYLE, {
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        angle: 0,
        mediaName: basename(im.file),
    });
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
        ...baseElement('arrow', `el-arrow-${i}`),
        type: 'arrow',
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: a.stroke ?? DEFAULT_ELEMENT_PROPS.strokeColor,
        strokeStyle: a.strokeStyle ?? DEFAULT_ELEMENT_PROPS.strokeStyle,
        ...DEFAULT_SKETCH_PROPS,
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
    settleEndpoints(arrow, byId);
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

function buildLabel(s: SitePlanShape, shape: VectorShapeElement): VectorRichTextElement {
    const fontSize = s.fontSize ?? DEFAULT_LABEL_SIZE;
    const { width, height } = measureRichTextBox(s.label, fontSize);
    return buildRichText(`el-${s.key}-label`, s.label, {
        x: shape.x + shape.width / 2 - width / 2,
        y: shape.y + shape.height / 2 - height / 2,
        width,
        height,
        angle: shape.angle,
        fontSize,
        color: SITE_PLAN_STYLE.color,
        textAlign: 'center',
        verticalAlign: 'center',
    });
}

function buildText(t: SitePlanText, i: number): VectorRichTextElement {
    const { width, height } = measureRichTextBox(t.text, t.fontSize);
    return buildRichText(`el-text-${i}`, t.text, {
        x: t.x,
        y: t.y,
        width,
        height,
        angle: 0,
        fontSize: t.fontSize,
        color: t.color ?? SITE_PLAN_STYLE.color,
        textAlign: 'left',
        verticalAlign: 'top',
    });
}

type RichTextSpec = Pick<
    VectorRichTextElement,
    'x' | 'y' | 'width' | 'height' | 'angle' | 'fontSize' | 'color' | 'textAlign' | 'verticalAlign'
>;

// Both text builders go through one place: the box the seeder measured plus the typography the drawing
// is authored in, over the shared rich-text factory.
function buildRichText(id: string, text: string, box: RichTextSpec): VectorRichTextElement {
    return richTextElement(id, SITE_PLAN_STYLE, {
        ...box,
        html: textToParagraphHtml(text),
        // The line height measureExcalifont sized the box with, so the text fills exactly that box.
        lineHeight: getFontMetrics(SITE_PLAN_STYLE.fontFamily).lineHeight,
    });
}
