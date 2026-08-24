import type * as Y from 'yjs';

// Origin stamped on the repair transaction so it escapes every host's UndoManager — all collab
// editors build theirs through useCollabDoc with default trackedOrigins ({null}), so any non-null
// origin is untracked. A corruption fix must never be undoable (⌘Z could restore the corruption),
// yet the repair still syncs to peers (y-websocket broadcasts every non-provider origin). Hosts do
// not reference this — their UndoManagers simply don't track it.
export const NORMALIZE_ORIGIN = Symbol('normalize-refs');

// Repair a parent→child reference structure held in a Yjs doc as: a `parentMap` of Y.Maps, each with
// a `childRefField` Y.Array<string> of child ids, plus a `childMap` of the children themselves. Two
// corruptions a concurrent merge can introduce:
//   1. a child referenced by MORE THAN ONE parent → keep the LAST parent's copy, delete the earlier;
//   2. a child referenced by NO parent (an orphan) → append it to the FIRST parent's ref array.
// Slides (slides / objects / objectIds) and stickies (columns / tasks / taskIds) share this exactly;
// slides' fontFamily backfill is a separate pass and stays slides-side. All writes run in ONE
// transaction under NORMALIZE_ORIGIN. Idempotent — a well-formed doc writes nothing, so it is safe to
// run once on sync and on every remote-origin merge.
export function normalizeParentChildRefs(doc: Y.Doc, parentMap: string, childMap: string, childRefField: string): void {
    const parents = doc.getMap(parentMap);
    const children = doc.getMap(childMap);
    const parentIds = Array.from(parents.keys());
    const childIds = Array.from(children.keys());

    const childToParents: Record<string, string[]> = {};
    for (const parentId of parentIds) {
        const parentValue = parents.get(parentId);
        if (!parentValue) continue;
        const parent = parentValue as Y.Map<unknown>;
        const refs = parent.get(childRefField) as Y.Array<string>;
        if (!refs) continue; // tolerate a parent missing its ref array
        for (const childId of refs.toArray() as string[]) {
            if (!childToParents[childId]) childToParents[childId] = [];
            childToParents[childId].push(parentId);
        }
    }

    doc.transact(() => {
        // Dedupe: keep the LAST parent's copy, delete from every earlier parent.
        for (const [childId, owners] of Object.entries(childToParents)) {
            if (owners.length <= 1) continue;
            for (let i = 0; i < owners.length - 1; i++) {
                const parentValue = parents.get(owners[i]);
                if (!parentValue) continue;
                const parent = parentValue as Y.Map<unknown>;
                const refs = parent.get(childRefField) as Y.Array<string>;
                const idx = (refs.toArray() as string[]).indexOf(childId);
                if (idx !== -1) refs.delete(idx, 1);
            }
        }

        // Orphan re-home: a child in no parent's refs → append to the FIRST parent's ref array.
        if (parentIds.length > 0) {
            const firstParentValue = parents.get(parentIds[0]);
            if (firstParentValue) {
                const firstParent = firstParentValue as Y.Map<unknown>;
                const firstRefs = firstParent.get(childRefField) as Y.Array<string>;
                for (const childId of childIds) {
                    if (!childToParents[childId] || childToParents[childId].length === 0) {
                        firstRefs.push([childId]);
                    }
                }
            }
        }
    }, NORMALIZE_ORIGIN);
}
