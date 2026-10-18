import {
    generateNKeysBetween,
    newElementId,
    newFrameId,
    readVectorFromDoc,
    remapBinding,
    SLIDES_STYLE_DEFAULTS,
    topmostIndex,
    type VectorScene,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';

// The deck writers for the pptx import (import/import-document.ts). The caller bounds the update's size and record
// count, and its media names must already be free in the deck's media folder: the writer copies `mediaName` and
// background image names as given.

// The update is built from an untrusted pptx, so it goes through the reader: a record a hostile peer
// write would be healed or dropped to is healed or dropped here too, and only the clean scene is written.
function readSlidesUpdate(update: Uint8Array): VectorScene {
    const scratch = new Y.Doc();
    try {
        Y.applyUpdate(scratch, update);
        return readVectorFromDoc(scratch);
    } finally {
        scratch.destroy();
    }
}

// Every record is new, under a fresh id, after the deck's topmost frame and element, in the update's
// own order. Nothing already in the deck is written, so an open tab's undo stack and comments stay valid.
// An element on no slide (an update without frames) has nowhere to land and is skipped.
function appendScene(doc: Y.Doc, scene: VectorScene): void {
    const frameIds = new Map<string, string>();
    const frameKeys = generateNKeysBetween(topmostIndex(doc.getMap('frames')), null, scene.frames.length);
    for (const [i, frame] of scene.frames.entries()) {
        const id = newFrameId();
        frameIds.set(frame.id, id);
        writeFrameInDoc(doc, { ...frame, id, index: frameKeys[i] });
    }

    // Every id is allocated before any write, because an arrow may bind to a shape above it.
    const placed = scene.elements.flatMap((el) => {
        const frameId = frameIds.get(el.frameId);
        return frameId === undefined ? [] : [{ el, frameId, id: newElementId() }];
    });
    const elementIds = new Map(placed.map(({ el, id }) => [el.id, id]));
    const keys = generateNKeysBetween(topmostIndex(doc.getMap('elements')), null, placed.length);
    for (const [i, { el, frameId, id }] of placed.entries()) {
        const element =
            el.type === 'arrow'
                ? {
                      ...el,
                      startBinding: remapBinding(el.startBinding, elementIds),
                      endBinding: remapBinding(el.endBinding, elementIds),
                  }
                : el;
        // An imported element has no comments; a card id it carried would name another element's card.
        writeElementInDoc(doc, { ...element, frameId, commentCardIds: '' }, keys[i], SLIDES_STYLE_DEFAULTS, id);
    }
}

// For Convert to Slides, which fills a brand-new deck, so the deck takes the update's meta too.
export function writeSlidesUpdateToYjs(doc: Y.Doc, update: Uint8Array): void {
    const scene = readSlidesUpdate(update);
    doc.transact(() => {
        appendScene(doc, scene);
        const meta = doc.getMap('meta');
        for (const [key, value] of Object.entries(scene.meta)) meta.set(key, value);
    });
}

// For importing slides into a deck someone works in: appended after its last slide, its meta left alone. Answers how
// many slides it appended.
export function appendSlidesUpdateToYjs(doc: Y.Doc, update: Uint8Array): number {
    const scene = readSlidesUpdate(update);
    doc.transact(() => appendScene(doc, scene));
    return scene.frames.length;
}
