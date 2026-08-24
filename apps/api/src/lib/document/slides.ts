import { type DeckData, yMapToObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type * as Y from 'yjs';

// Materialized Yjs doc → DeckData. Media-free, so it runs identically on the main
// thread and inside the document-transform Worker (which has no Mount). Every consumer
// of a persisted deck reads it in the Worker, so the Mount-side loader is gone: capture
// (collab-source.ts) + materialize (yjs-loader.ts) is the only path in.
export function readDeckFromDoc(doc: Y.Doc): DeckData {
    const slidesMap = doc.getMap('slides');
    const objectsMap = doc.getMap('objects');
    const slideOrderArray = doc.getArray('slideOrder');

    const deck: DeckData = { slides: {}, objects: {}, slideOrder: slideOrderArray.toArray() as string[] };

    for (const [slideId, slideMapValue] of slidesMap) {
        const slideMap = slideMapValue as Y.Map<unknown>;
        const objIdsArray = slideMap.get('objectIds') as Y.Array<string>;
        const objIds = objIdsArray ? (objIdsArray.toArray() as string[]) : [];
        const bgRaw = slideMap.get('background');
        deck.slides[slideId] = {
            id: slideId,
            objectIds: objIds,
            background: bgRaw && typeof bgRaw === 'object' ? (bgRaw as BackgroundFill) : null,
        };
    }

    for (const [objId, objMapValue] of objectsMap) {
        deck.objects[objId] = yMapToObject(objMapValue as Y.Map<unknown>);
    }

    return deck;
}
