// Repairs a parent-to-child reference structure in a Yjs doc after a concurrent merge, such as a stickies board's
// columns and the task ids each lists. A child two parents list stays only in the last parent in document order, and
// a child no parent lists joins the first. A host runs it on sync and after every remote merge; a well-formed doc
// writes nothing.

import type * as Y from 'yjs';
import { getIdArray, getItemMapRoot } from './yjs-utils';

// A non-null origin escapes every UndoManager useCollabDoc builds, so ⌘Z can't restore the corruption. The repair
// still syncs to peers.
const NORMALIZE_ORIGIN = Symbol('normalize-refs');

// Document order is the host's `orderArrayName` array, which converges across peers where map key order does not. A
// parent missing from it is a stray: it ranks before every ordered parent, so it keeps a child only when it is the
// sole holder and never takes an orphan. With no ordered parents at all, map key order decides.
export function normalizeParentChildRefs(
    doc: Y.Doc,
    parentMap: string,
    childMap: string,
    childRefField: string,
    orderArrayName: string,
): void {
    const parents = getItemMapRoot(doc, parentMap);
    const children = doc.getMap(childMap);
    const parentIds = Array.from(parents.keys());
    const childIds = Array.from(children.keys());

    // A merged order array can hold an id twice, or one with no parent; the first real one counts.
    const parentSet = new Set(parentIds);
    const orderedParents: string[] = [];
    const seen = new Set<string>();
    for (const id of doc.getArray<string>(orderArrayName).toArray()) {
        if (parentSet.has(id) && !seen.has(id)) {
            seen.add(id);
            orderedParents.push(id);
        }
    }
    const strays = parentIds.filter((id) => !seen.has(id));
    const sequence = [...strays, ...orderedParents];
    const rank: Record<string, number> = {};
    for (let i = 0; i < sequence.length; i++) rank[sequence[i]] = i;

    const childToParents: Record<string, string[]> = {};
    for (const parentId of parentIds) {
        const refs = getIdArray(parents.get(parentId), childRefField);
        if (!refs) continue;
        for (const childId of refs.toArray()) {
            (childToParents[childId] ??= []).push(parentId);
        }
    }

    doc.transact(() => {
        // A parent listing a child twice appears twice in `owners`, so its lower entry is deleted too.
        for (const [childId, owners] of Object.entries(childToParents)) {
            if (owners.length <= 1) continue;
            owners.sort((a, b) => rank[a] - rank[b]);
            for (let i = 0; i < owners.length - 1; i++) {
                const refs = getIdArray(parents.get(owners[i]), childRefField);
                if (!refs) continue;
                const idx = refs.toArray().indexOf(childId);
                if (idx !== -1) refs.delete(idx, 1);
            }
        }

        const homeParentId = orderedParents[0] ?? sequence[0];
        if (homeParentId !== undefined) {
            const homeRefs = getIdArray(parents.get(homeParentId), childRefField);
            // A collaborator's edit can drop a parent's array, and a throw would escape into the observer.
            if (!homeRefs) return;
            for (const childId of childIds) {
                if (!childToParents[childId]) homeRefs.push([childId]);
            }
        }
    }, NORMALIZE_ORIGIN);
}
