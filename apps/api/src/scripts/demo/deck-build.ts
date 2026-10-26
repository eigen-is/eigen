// Builds the sponsor deck straight into a slides container's Y.Doc from the typed SPONSOR_DECK spec (content.ts) — the
// site-plan approach (vector-build.ts) rather than a byte-copied fixture, because a deck is a canvas document now and
// frozen bytes cannot survive a stored-shape change. One frame per slide, elements positioned relative to the frame;
// the deck writes no meta.slideSize, so it is 16:9. Every frame and element goes through the editor's own writer
// (write-vector.ts), so the doc reads back through read-vector unchanged. Deterministic ids and indices: a reseed
// rebuilds the same deck.

import { basename } from 'node:path';
import type { NewVectorElement, StyleDefaults } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_RICHTEXT_PROPS,
    generateNKeysBetween,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { DeckImage, DeckSlide, DeckText } from './content';
import { DECK_INK } from './content';

// The deck's style table: the slides app's own, in the deck's ink — what an editor-authored element inherits.
const DECK_STYLE: StyleDefaults = { ...SLIDES_STYLE_DEFAULTS, color: DECK_INK };

// An element under its fixed id, so a reseed writes the same keys.
type DeckElement = { id: string; element: NewVectorElement };

export function buildDeckDoc(doc: Y.Doc, slides: DeckSlide[]): void {
    const frameKeys = generateNKeysBetween(null, null, slides.length);
    const frames = slides.map((slide, i) => ({
        id: `frame-${slide.key}`,
        index: frameKeys[i],
        name: slide.name,
        background: serializeBackgroundFill(slide.background),
    }));
    const ordered: DeckElement[] = [];
    for (const [slideIndex, slide] of slides.entries()) {
        const frameId = frames[slideIndex].id;
        const images = (slide.images ?? []).map((image, i) => buildImage(image, slide.key, frameId, i));
        const texts = slide.texts.map((text, i) => buildText(text, slide.key, frameId, i));
        // Bottom-up within the slide: images, then every text on top.
        ordered.push(...images, ...texts);
    }

    // One global z-order across the deck; a frame clips to its own elements, so the run per slide is
    // what orders a slide's painting.
    const keys = generateNKeysBetween(null, null, ordered.length);
    doc.transact(() => {
        for (const frame of frames) writeFrameInDoc(doc, frame);
        for (const [i, { id, element }] of ordered.entries()) writeElementInDoc(doc, element, keys[i], DECK_STYLE, id);
    });
}

// The shared seed rather than a per-element draw the way vector-build.ts does: the deck's style table is
// roughness 0, so every element is drawn crisp and the seed changes nothing but a reseed's bytes.
function buildText(t: DeckText, slideKey: string, frameId: string, i: number): DeckElement {
    const element: NewVectorElement = {
        type: 'richtext',
        frameId,
        seed: DEFAULT_ELEMENT_PROPS.seed,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        html: t.html,
        fontFamily: t.font ?? DECK_STYLE.fontFamily,
        fontSize: t.fontSize,
        fontWeight: t.bold ? 'bold' : DEFAULT_RICHTEXT_PROPS.fontWeight,
        color: t.color ?? DECK_STYLE.color,
        textAlign: t.align ?? DEFAULT_RICHTEXT_PROPS.textAlign,
        verticalAlign: t.valign ?? DEFAULT_RICHTEXT_PROPS.verticalAlign,
    };
    return { id: `el-${slideKey}-text-${i}`, element };
}

function buildImage(im: DeckImage, slideKey: string, frameId: string, i: number): DeckElement {
    const element: NewVectorElement = {
        type: 'image',
        frameId,
        seed: DEFAULT_ELEMENT_PROPS.seed,
        x: im.x,
        y: im.y,
        width: im.width,
        height: im.height,
        mediaName: basename(im.file),
    };
    return { id: `el-${slideKey}-image-${i}`, element };
}
