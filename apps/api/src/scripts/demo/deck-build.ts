// Builds the sponsor deck straight into a slides container's Y.Doc from the typed SPONSOR_DECK spec, as the site-plan
// drawing is built, because frozen bytes could not survive a change to the stored shape. One frame per slide, each
// element relative to its frame, and no meta.slideSize, so the deck is 16:9. Every record goes through the editor's
// own writer, writeElementInDoc, so the doc reads back unchanged, and fixed ids and indices make a reseed identical.

import { basename } from 'node:path';
import type { NewVectorElement, StyleDefaults } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_TEXT_BOX_PROPS,
    generateNKeysBetween,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { DeckImage, DeckSlide, DeckText } from './content';
import { DECK_INK } from './content';

// The Slides app's own style table in the deck's ink, as an element drawn in the editor gets it.
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

    // One z-order runs across the whole deck. A frame draws only its own elements, so each slide's run of keys
    // orders its painting.
    const keys = generateNKeysBetween(null, null, ordered.length);
    doc.transact(() => {
        for (const frame of frames) writeFrameInDoc(doc, frame);
        for (const [i, { id, element }] of ordered.entries()) writeElementInDoc(doc, element, keys[i], DECK_STYLE, id);
    });
}

// One shared seed and not a draw per element, as the drawing takes. The deck's style table has roughness 0, so
// every element draws crisp and a seed would change nothing but the bytes of a reseed.
function buildText(t: DeckText, slideKey: string, frameId: string, i: number): DeckElement {
    const element: NewVectorElement = {
        type: 'rectangle',
        autoFit: true,
        frameId,
        seed: DEFAULT_ELEMENT_PROPS.seed,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        html: t.html,
        fontFamily: t.font ?? DECK_STYLE.fontFamily,
        fontSize: t.fontSize,
        fontWeight: t.bold ? 'bold' : DEFAULT_TEXT_BOX_PROPS.fontWeight,
        color: t.color ?? DECK_STYLE.color,
        textAlign: t.align ?? DEFAULT_TEXT_BOX_PROPS.textAlign,
        verticalAlign: t.valign ?? DEFAULT_TEXT_BOX_PROPS.verticalAlign,
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
