import type { DeckData, SlideObject } from '@workspace/lib/slides';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type * as Y from 'yjs';

const OBJECT_FIELDS = [
    'id',
    'slideId',
    'type',
    'x',
    'y',
    'w',
    'h',
    'rotation',
    'borderColor',
    'borderWidth',
    'borderRadius',
    'text',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'textDecoration',
    'textAlign',
    'verticalAlign',
    'color',
    'letterSpacing',
    'lineHeight',
    'highlightColor',
    'background',
    'mediaName',
    'objectFit',
    'commentCardIds',
] as const;

function yMapToSlideObject(yMap: Y.Map<unknown>): SlideObject {
    const obj: Record<string, unknown> = {};
    for (const field of OBJECT_FIELDS) {
        const val = yMap.get(field);
        if (val !== undefined) obj[field] = val;
    }
    const raw = obj['commentCardIds'];
    if (raw && typeof (raw as Y.Array<string>).toArray === 'function') {
        obj['commentCardIds'] = (raw as Y.Array<string>).toArray();
    } else if (!Array.isArray(raw)) {
        obj['commentCardIds'] = [];
    }
    return obj as SlideObject;
}

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
        deck.objects[objId] = yMapToSlideObject(objMapValue as Y.Map<unknown>);
    }

    return deck;
}
