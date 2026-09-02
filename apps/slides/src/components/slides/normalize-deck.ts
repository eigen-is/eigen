import { getIdArray, getItemMapRoot, NORMALIZE_ORIGIN, normalizeParentChildRefs } from '@workspace/lib/collab';
import type * as Y from 'yjs';

export function normalizeDeck(doc: Y.Doc) {
    // Shared parent→child ref repair (U6d): dedupe objects referenced by multiple slides (keep the
    // last in slideOrder) and re-home orphaned objects to the first slide in slideOrder.
    normalizeParentChildRefs(doc, 'slides', 'objects', 'objectIds', 'slideOrder');

    // Slides-only pass, untracked like the shared ref repair (NORMALIZE_ORIGIN escapes the
    // UndoManager) — a corruption fix is never a user undo step; nested in a remote transaction it rides
    // that origin, also untracked.
    const objectsMap = getItemMapRoot(doc, 'objects');
    const slidesMap = getItemMapRoot(doc, 'slides');
    doc.transact(() => {
        // Reconcile each object's slideId back-reference to the slide that actually holds it. objectIds
        // is the source of truth; the shared repair may have re-homed or dedupe-moved an object without
        // touching its slideId, which drives duplicate/z-order writes and comment/search navigation.
        for (const slideId of Array.from(slidesMap.keys())) {
            const slide = slidesMap.get(slideId);
            const objectIds = slide && getIdArray(slide, 'objectIds');
            if (!objectIds) continue; // tolerate a slide missing objectIds — a throw escapes the observer
            for (const objId of objectIds.toArray()) {
                const obj = objectsMap.get(objId);
                if (!obj) continue;
                if (obj.get('slideId') !== slideId) obj.set('slideId', slideId); // write only on change
            }
        }
    }, NORMALIZE_ORIGIN);
}
