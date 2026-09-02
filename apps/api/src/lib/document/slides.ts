import { getIdArray, getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import { type DeckData, yMapToObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type * as Y from 'yjs';

// Materialized Yjs doc → DeckData. Media-free, so it runs identically on the main
// thread and inside the document-transform Worker (which has no Mount). Every consumer
// of a persisted deck reads it in the Worker, so the Mount-side loader is gone: capture
// (collab-source.ts) + materialize (yjs-loader.ts) is the only path in.
export function readDeckFromDoc(doc: Y.Doc): DeckData {
    const slidesMap = getItemMapRoot(doc, 'slides');
    const objectsMap = getItemMapRoot(doc, 'objects');
    const slideOrderArray = getIdArrayRoot(doc, 'slideOrder');

    const deck: DeckData = { slides: {}, objects: {}, slideOrder: slideOrderArray.toArray() };

    for (const [slideId, slideMap] of slidesMap) {
        const objIds = getIdArray(slideMap, 'objectIds')?.toArray() ?? [];
        const bgRaw = slideMap.get('background');
        deck.slides[slideId] = {
            id: slideId,
            objectIds: objIds,
            background: bgRaw && typeof bgRaw === 'object' ? (bgRaw as BackgroundFill) : null,
        };
    }

    for (const [objId, objMap] of objectsMap) {
        deck.objects[objId] = yMapToObject(objMap);
    }

    return deck;
}
