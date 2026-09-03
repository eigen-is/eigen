// Builds the sponsor deck straight into a slides container's Y.Doc from the typed SPONSOR_DECK spec
// (content.ts) — the site-plan approach (vector-build.ts) rather than a byte-copied fixture, because a
// deck is a canvas document now and frozen bytes cannot survive a stored-shape change. One frame per
// slide, pinned 1920x1080, elements positioned relative to the frame. Every element carries the full
// field set an editor-authored one would (use-canvas-doc's addElement), so the doc reads back through
// read-vector unchanged. Deterministic ids, indices and seeds: a reseed rebuilds the same deck.

import { basename } from 'node:path';
import {
    baseDefaultsFor,
    bindingAnchor,
    DEFAULT_OBJECT_FIT,
    DEFAULT_RICHTEXT_PROPS,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    FRAME_FIELDS,
    followBindings,
    generateNKeysBetween,
    normalizeLinear,
    SLIDES_STYLE_DEFAULTS,
    type StyleDefaults,
    serializeBackgroundFill,
    serializeBinding,
    shapeAnchorPoints,
    solidFill,
    TRANSPARENT_COLOR,
    type VectorArrowElement,
    type VectorElement,
    type VectorFrame,
    type VectorImageElement,
    type VectorRichTextElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { type CanvasSide, mulberry32, SIDE_INDEX, ZERO_BOX } from './canvas-build';
import { DECK_INK, type DeckArrow, type DeckImage, type DeckShape, type DeckSlide, type DeckText } from './content';

// Fixed PRNG salt so every reseed draws the same roughjs seeds. The deck is flat (roughness 0), but
// the field is stored either way and an author who raises roughness gets a stable drawing.
const SEED_SALT = 0x5d_ec_4b_21;
// The deck's style table: the slides app's own, in the deck's ink — what an editor-authored element inherits.
const DECK_STYLE: StyleDefaults = { ...SLIDES_STYLE_DEFAULTS, color: DECK_INK };

type StoredFrame = Omit<VectorFrame, 'width' | 'height'>;

export function buildDeckDoc(doc: Y.Doc, slides: DeckSlide[]): void {
    // Stored frame fields only: width/height are the FRAME_WIDTH/FRAME_HEIGHT constants, never persisted.
    const frames: StoredFrame[] = [];
    const ordered: VectorElement[] = [];
    const frameKeys = generateNKeysBetween(null, null, slides.length);

    for (const [slideIndex, slide] of slides.entries()) {
        const frameId = `frame-${slide.key}`;
        frames.push({
            id: frameId,
            index: frameKeys[slideIndex],
            name: slide.name,
            background: serializeBackgroundFill(slide.background),
        });

        const shapes = (slide.shapes ?? []).map((shape) => buildShape(shape, slide.key, frameId));
        const byKey = new Map((slide.shapes ?? []).map((shape, i) => [shape.key, shapes[i]]));
        const byId = new Map<string, VectorElement>(shapes.map((shape) => [shape.id, shape]));
        const images = (slide.images ?? []).map((image, i) => buildImage(image, slide.key, frameId, i));
        const arrows = (slide.arrows ?? []).map((arrow, i) => buildArrow(arrow, slide.key, frameId, i, byKey, byId));
        const texts = slide.texts.map((text, i) => buildText(text, slide.key, frameId, i));
        // Bottom-up within the slide: shapes, images, arrows, then every text on top.
        ordered.push(...shapes, ...images, ...arrows, ...texts);
    }

    // One global z-order across the deck; a frame clips to its own elements, so the run per slide is
    // what orders a slide's painting.
    const keys = generateNKeysBetween(null, null, ordered.length);
    const seed = mulberry32(SEED_SALT);
    for (const [i, element] of ordered.entries()) {
        element.index = keys[i];
        // One draw per element either way, so adding an unsketched kind never shifts the others' seeds.
        const drawn = Math.floor(seed() * 2 ** 31);
        if ('seed' in element) element.seed = drawn;
    }

    // Every object is built with only stored keys, so a plain entries walk is the write allow-list
    // (the guard keeps that guarantee if either model grows a non-stored field — a frame's w/h are).
    doc.transact(() => {
        const framesMap = doc.getMap('frames');
        const elementsMap = doc.getMap('elements');
        for (const frame of frames) framesMap.set(frame.id, toYMap(frame, FRAME_FIELDS));
        for (const element of ordered) elementsMap.set(element.id, toYMap(element, ELEMENT_FIELDS));
    });
}

function toYMap(source: object, fields: readonly string[]): Y.Map<unknown> {
    const allowed = new Set(fields);
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && allowed.has(key)) map.set(key, value);
    }
    return map;
}

function buildText(t: DeckText, slideKey: string, frameId: string, i: number): VectorRichTextElement {
    return {
        ...baseDefaultsFor('richtext'),
        ...ELEMENT_KINDS.richtext.defaults(DECK_STYLE),
        id: `el-${slideKey}-text-${i}`,
        type: 'richtext',
        index: '',
        frameId,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        angle: 0,
        html: t.html,
        fontSize: t.fontSize,
        fontWeight: t.bold ? 'bold' : DEFAULT_RICHTEXT_PROPS.fontWeight,
        color: t.color ?? DECK_STYLE.color,
        textAlign: t.align ?? DEFAULT_RICHTEXT_PROPS.textAlign,
        verticalAlign: t.valign ?? DEFAULT_RICHTEXT_PROPS.verticalAlign,
    };
}

function buildShape(s: DeckShape, slideKey: string, frameId: string): VectorShapeElement {
    const box = {
        ...baseDefaultsFor(s.kind),
        id: `el-${slideKey}-${s.key}`,
        index: '',
        frameId,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        angle: 0,
        strokeColor: s.stroke ?? DECK_STYLE.strokeColor,
        strokeWidth: s.strokeWidth ?? DECK_STYLE.strokeWidth,
        fill: solidFill(s.fill ?? TRANSPARENT_COLOR),
        roughness: DECK_STYLE.roughness,
        seed: 0,
    };
    // An ellipse has no corners to treat, so it carries no `corners` field.
    if (s.kind === 'ellipse') return { ...box, type: 'ellipse' };
    return { ...box, type: 'rectangle', corners: DECK_STYLE.corners };
}

function buildImage(im: DeckImage, slideKey: string, frameId: string, i: number): VectorImageElement {
    return {
        ...baseDefaultsFor('image'),
        id: `el-${slideKey}-image-${i}`,
        type: 'image',
        index: '',
        frameId,
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        angle: 0,
        mediaName: basename(im.file),
        corners: DECK_STYLE.corners,
        objectFit: DEFAULT_OBJECT_FIT,
    };
}

function buildArrow(
    a: DeckArrow,
    slideKey: string,
    frameId: string,
    i: number,
    byKey: Map<string, VectorShapeElement>,
    byId: Map<string, VectorElement>,
): VectorArrowElement {
    const from = dockOn(a.from, byKey);
    const to = dockOn(a.to, byKey);
    const norm = normalizeLinear(ZERO_BOX, [from.point, to.point]);
    const arrow: VectorArrowElement = {
        ...baseDefaultsFor('arrow'),
        ...ELEMENT_KINDS.arrow.defaults(DECK_STYLE),
        id: `el-${slideKey}-arrow-${i}`,
        type: 'arrow',
        index: '',
        frameId,
        x: norm.x,
        y: norm.y,
        width: norm.width,
        height: norm.height,
        angle: 0,
        strokeColor: a.stroke ?? DECK_STYLE.strokeColor,
        points: norm.points,
        startBinding: from.binding,
        endBinding: to.binding,
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

// An arrow end: a real binding to a named shape's side midpoint.
function dockOn(
    end: { shape: string; side: CanvasSide },
    byKey: Map<string, VectorShapeElement>,
): { point: { x: number; y: number }; binding: string } {
    const shape = byKey.get(end.shape);
    if (!shape) throw new Error(`deck arrow binds to unknown shape ${end.shape}`);
    const dock = shapeAnchorPoints(shape)[SIDE_INDEX[end.side]];
    return { point: dock, binding: serializeBinding({ elementId: shape.id, fixedPoint: bindingAnchor(shape, dock) }) };
}
