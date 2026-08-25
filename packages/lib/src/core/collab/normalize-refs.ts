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
//   1. a child referenced by MORE THAN ONE parent → keep the copy in the LAST parent in document order;
//   2. a child referenced by NO parent (an orphan) → append it to the FIRST parent in document order.
// "Document order" is the host's `orderArrayName` Y.Array (slides' slideOrder, stickies' columnOrder),
// which converges across peers where Y.Map key order does not. Parents present in the map but absent
// from that array are "strays" — themselves a corruption — and rank BEFORE every ordered parent, so a
// stray only wins the dedupe when it is the sole holder and is never chosen as a re-home target (both
// would park a child on a parent the UI never renders). With no ordered parents at all (order array
// empty/unseeded) we fall back to map-key order. Slides (slides / objects / objectIds / slideOrder)
// and stickies (columns / tasks / taskIds / columnOrder) share this exactly; slides' fontFamily
// backfill and slideId reconciliation are separate passes and stay slides-side. All writes run in ONE
// transaction under NORMALIZE_ORIGIN. Idempotent — a well-formed doc writes nothing, so it is safe to
// run once on sync and on every remote-origin merge.
export function normalizeParentChildRefs(
    doc: Y.Doc,
    parentMap: string,
    childMap: string,
    childRefField: string,
    orderArrayName: string,
): void {
    const parents = doc.getMap(parentMap);
    const children = doc.getMap(childMap);
    const parentIds = Array.from(parents.keys());
    const childIds = Array.from(children.keys());

    // Rank parents by document order. Ordered parents are the order array's entries that actually
    // exist, de-duplicated keeping first occurrence (a merged order array can hold duplicates); strays
    // rank ahead of them, in map-key order. Higher rank = later in the sequence = dedupe survivor.
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
        // Dedupe: keep the highest-ranked holder (last in document order), delete from every lower one.
        // A parent listing the same child twice appears twice in `owners`, so one of its entries is a
        // lower "holder" and gets deleted — the re-read after each delete is what collapses it.
        for (const [childId, owners] of Object.entries(childToParents)) {
            if (owners.length <= 1) continue;
            owners.sort((a, b) => rank[a] - rank[b]);
            for (let i = 0; i < owners.length - 1; i++) {
                const parentValue = parents.get(owners[i]);
                if (!parentValue) continue;
                const parent = parentValue as Y.Map<unknown>;
                const refs = parent.get(childRefField) as Y.Array<string>;
                const idx = (refs.toArray() as string[]).indexOf(childId);
                if (idx !== -1) refs.delete(idx, 1);
            }
        }

        // Orphan re-home: a child in no parent's refs → append to the first ordered parent, skipping
        // strays. No ordered parents → fall back to map-key order (sequence[0]).
        const homeParentId = orderedParents.length > 0 ? orderedParents[0] : sequence[0];
        if (homeParentId !== undefined) {
            const homeValue = parents.get(homeParentId);
            if (homeValue) {
                const homeParent = homeValue as Y.Map<unknown>;
                const homeRefs = homeParent.get(childRefField) as Y.Array<string> | undefined;
                if (!homeRefs) return; // tolerate here too — a throw would escape into the observer
                for (const childId of childIds) {
                    if (!childToParents[childId] || childToParents[childId].length === 0) {
                        homeRefs.push([childId]);
                    }
                }
            }
        }
    }, NORMALIZE_ORIGIN);
}
