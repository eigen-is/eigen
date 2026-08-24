import { NORMALIZE_ORIGIN, normalizeParentChildRefs } from '@workspace/lib/collab';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import type * as Y from 'yjs';

export function normalizeDeck(doc: Y.Doc) {
    // Shared parent→child ref repair (U6d): dedupe objects referenced by multiple slides (keep the
    // last) and re-home orphaned objects to the first slide.
    normalizeParentChildRefs(doc, 'slides', 'objects', 'objectIds');

    // Slides-only pass: backfill a default font on legacy text objects that stored none. Untracked
    // like the shared ref repair (NORMALIZE_ORIGIN escapes the UndoManager) — a corruption fix is never
    // a user undo step; nested in a remote transaction it rides that origin, also untracked.
    const objectsMap = doc.getMap('objects');
    doc.transact(() => {
        for (const objId of Array.from(objectsMap.keys())) {
            const objValue = objectsMap.get(objId);
            if (!objValue) continue;
            const obj = objValue as Y.Map<unknown>;
            if (obj.get('type') === 'text' && !obj.get('fontFamily')) {
                obj.set('fontFamily', EIGEN_FONTS[0].name);
            }
        }
    }, NORMALIZE_ORIGIN);
}
