// Builds the sponsor deck straight into a slides container's Y.Doc from the typed SPONSOR_DECK spec
// (content.ts) — the site-plan approach (vector-build.ts) rather than a byte-copied fixture, because a
// deck is a canvas document now and frozen bytes cannot survive a stored-shape change. One frame per
// slide, pinned 1920x1080, elements positioned relative to the frame. Every element carries the full
// field set an editor-authored one would (use-canvas-doc's addElement), so the doc reads back through
// read-vector unchanged. Deterministic ids and indices: a reseed rebuilds the same deck.

import { basename } from 'node:path';
import {
    DEFAULT_RICHTEXT_PROPS,
    ELEMENT_FIELDS,
    FRAME_FIELDS,
    generateNKeysBetween,
    SLIDES_STYLE_DEFAULTS,
    type StyleDefaults,
    serializeBackgroundFill,
    type VectorElement,
    type VectorFrame,
    type VectorImageElement,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { imageElement, richTextElement, toYMap } from './canvas-build';
import { DECK_INK, type DeckImage, type DeckSlide, type DeckText } from './content';

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

        const images = (slide.images ?? []).map((image, i) => buildImage(image, slide.key, frameId, i));
        const texts = slide.texts.map((text, i) => buildText(text, slide.key, frameId, i));
        // Bottom-up within the slide: images, then every text on top.
        ordered.push(...images, ...texts);
    }

    // One global z-order across the deck; a frame clips to its own elements, so the run per slide is
    // what orders a slide's painting.
    // A deck holds only rich text and pictures, neither of which roughjs draws, so there is no seed to
    // settle here the way vector-build.ts does.
    const keys = generateNKeysBetween(null, null, ordered.length);
    for (const [i, element] of ordered.entries()) element.index = keys[i];

    // Every object is built with only stored keys, so a plain entries walk is the write allow-list
    // (the guard keeps that guarantee if either model grows a non-stored field — a frame's w/h are).
    doc.transact(() => {
        const framesMap = doc.getMap('frames');
        const elementsMap = doc.getMap('elements');
        for (const frame of frames) framesMap.set(frame.id, toYMap(frame, FRAME_FIELDS));
        for (const element of ordered) elementsMap.set(element.id, toYMap(element, ELEMENT_FIELDS));
    });
}

function buildText(t: DeckText, slideKey: string, frameId: string, i: number): VectorRichTextElement {
    return richTextElement(`el-${slideKey}-text-${i}`, DECK_STYLE, {
        frameId,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        angle: 0,
        html: t.html,
        fontFamily: t.font ?? DECK_STYLE.fontFamily,
        fontSize: t.fontSize,
        fontWeight: t.bold ? 'bold' : DEFAULT_RICHTEXT_PROPS.fontWeight,
        color: t.color ?? DECK_STYLE.color,
        textAlign: t.align ?? DEFAULT_RICHTEXT_PROPS.textAlign,
        verticalAlign: t.valign ?? DEFAULT_RICHTEXT_PROPS.verticalAlign,
    });
}

function buildImage(im: DeckImage, slideKey: string, frameId: string, i: number): VectorImageElement {
    return imageElement(`el-${slideKey}-image-${i}`, DECK_STYLE, {
        frameId,
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        angle: 0,
        mediaName: basename(im.file),
    });
}
