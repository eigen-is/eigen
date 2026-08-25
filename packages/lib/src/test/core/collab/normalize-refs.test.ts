import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { NORMALIZE_ORIGIN, normalizeParentChildRefs } from '../../../core/collab/normalize-refs';

// Build a doc shaped like slides/stickies: a `parents` map of Y.Maps each holding a `refs` Y.Array of
// child ids, plus a `children` map of the children themselves, plus an `order` Y.Array naming the
// parents in document order (left unseeded when a test wants the degenerate map-key fallback).
function makeDoc(parents: Record<string, string[]>, children: string[], order?: string[]): Y.Doc {
    const doc = new Y.Doc();
    const parentsMap = doc.getMap('parents');
    const childrenMap = doc.getMap('children');
    doc.transact(() => {
        for (const [parentId, refs] of Object.entries(parents)) {
            const p = new Y.Map();
            p.set('id', parentId);
            const arr = new Y.Array<string>();
            arr.push(refs);
            p.set('refs', arr);
            parentsMap.set(parentId, p);
        }
        for (const childId of children) childrenMap.set(childId, new Y.Map());
        if (order) doc.getArray<string>('order').push(order);
    });
    return doc;
}

function refsOf(doc: Y.Doc, parentId: string): string[] {
    const p = doc.getMap('parents').get(parentId) as Y.Map<unknown>;
    return (p.get('refs') as Y.Array<string>).toArray();
}

describe('normalizeParentChildRefs', () => {
    test('dedupes a child in multiple parents, keeping the LAST parent copy', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'] }, ['c1']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual([]);
        expect(refsOf(doc, 'p2')).toEqual(['c1']);
    });

    test('keeps last across three parents (deletes from every earlier one)', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'], p3: ['c1'] }, ['c1']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual([]);
        expect(refsOf(doc, 'p2')).toEqual([]);
        expect(refsOf(doc, 'p3')).toEqual(['c1']);
    });

    test('re-homes an orphaned child to the FIRST parent', () => {
        const doc = makeDoc({ p1: [], p2: [] }, ['orphan']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual(['orphan']);
        expect(refsOf(doc, 'p2')).toEqual([]);
    });

    test('tolerates a parent missing its ref array', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            const parentsMap = doc.getMap('parents');
            const bare = new Y.Map();
            bare.set('id', 'p1'); // no 'refs' array
            parentsMap.set('p1', bare);
            const p2 = new Y.Map();
            const arr = new Y.Array<string>();
            arr.push(['c1']);
            p2.set('refs', arr);
            parentsMap.set('p2', p2);
            doc.getMap('children').set('c1', new Y.Map());
        });
        expect(() => normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order')).not.toThrow();
        expect(refsOf(doc, 'p2')).toEqual(['c1']);
    });

    test('tolerates an orphan when the first parent has no ref array', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            const bare = new Y.Map();
            bare.set('id', 'p1'); // no 'refs' array
            doc.getMap('parents').set('p1', bare);
            doc.getMap('children').set('orphan', new Y.Map());
        });
        expect(() => normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order')).not.toThrow();
    });

    test('is idempotent — a well-formed doc is left untouched', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c2'] }, ['c1', 'c2']);
        const before = Y.encodeStateAsUpdate(doc);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        // No structural change beyond an empty transaction: refs identical.
        expect(refsOf(doc, 'p1')).toEqual(['c1']);
        expect(refsOf(doc, 'p2')).toEqual(['c2']);
        // A second run over an already-clean doc makes no writes.
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual(['c1']);
        expect(Y.encodeStateAsUpdate(doc).length).toBeGreaterThanOrEqual(before.length);
    });

    test('repairs run under NORMALIZE_ORIGIN — an UndoManager (default trackedOrigins) ignores them', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'] }, ['c1']);
        const um = new Y.UndoManager([doc.getMap('parents')]);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual([]); // repaired
        expect(um.canUndo()).toBe(false); // but not on the undo stack
        um.undo();
        expect(refsOf(doc, 'p1')).toEqual([]); // undo is a no-op — the corruption stays fixed
    });

    test('stamps the repair transaction with NORMALIZE_ORIGIN', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'] }, ['c1']);
        let seenOrigin: unknown;
        doc.on('afterTransaction', (tr) => {
            if (tr.changed.size > 0) seenOrigin = tr.origin;
        });
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(seenOrigin).toBe(NORMALIZE_ORIGIN);
    });

    test('re-homes an orphan onto the first parent in document order, not the first map key', () => {
        // Parents created s1,s2,s3 but the deck reads s3,s1,s2 — the orphan must land on s3.
        const doc = makeDoc({ s1: [], s2: [], s3: [] }, ['orphan'], ['s3', 's1', 's2']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 's3')).toEqual(['orphan']);
        expect(refsOf(doc, 's1')).toEqual([]);
        expect(refsOf(doc, 's2')).toEqual([]);
    });

    test('dedupe keeps the parent that is last in document order, not last by map key', () => {
        const doc = makeDoc({ s1: ['c1'], s2: ['c1'], s3: ['c1'] }, ['c1'], ['s3', 's1', 's2']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 's3')).toEqual([]);
        expect(refsOf(doc, 's1')).toEqual([]);
        expect(refsOf(doc, 's2')).toEqual(['c1']); // s2 is last in document order
    });

    test('a stray parent (absent from the order array) loses the dedupe and is never the re-home target', () => {
        const doc = makeDoc({ stray: ['c1'], ordered: ['c1'] }, ['c1', 'orphan'], ['ordered']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'stray')).toEqual([]); // stray never wins the dedupe
        expect(refsOf(doc, 'ordered')).toEqual(['c1', 'orphan']); // survivor + re-home target
    });

    test('a stray that is the only holder keeps its child — no data loss', () => {
        // order names only a non-existent parent, so `stray` ranks alone and must keep c1.
        const doc = makeDoc({ stray: ['c1'] }, ['c1'], ['ghost']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'stray')).toEqual(['c1']);
    });

    test('order array never seeded falls back to map-key order (degenerate case)', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'] }, ['c1', 'orphan']); // no order seeded
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual(['orphan']); // orphan → first map key
        expect(refsOf(doc, 'p2')).toEqual(['c1']); // dedupe survivor → last map key
    });

    test('collapses intra-parent duplicate refs (regression guard)', () => {
        // Seed the childMap only with ids the parent references, so no stray id becomes an orphan.
        const a = makeDoc({ A: ['c1', 'c1'] }, ['c1'], ['A']);
        normalizeParentChildRefs(a, 'parents', 'children', 'refs', 'order');
        expect(refsOf(a, 'A')).toEqual(['c1']);

        const b = makeDoc({ A: ['x', 'c1', 'c1', 'y'] }, ['x', 'c1', 'y'], ['A']);
        normalizeParentChildRefs(b, 'parents', 'children', 'refs', 'order');
        expect(refsOf(b, 'A')).toEqual(['x', 'c1', 'y']);
    });

    test('two peers with divergent map-key order but a shared order array converge to one survivor', () => {
        const x = new Y.Doc();
        const y = new Y.Doc();

        // Concurrent creation: x makes p1 first, y makes p2 first. After exchange their Y.Map key
        // orders diverge (each integrates its own key ahead of the remote one) — the 1b condition.
        const seedParent = (doc: Y.Doc, id: string) => {
            const p = new Y.Map();
            const arr = new Y.Array<string>();
            arr.push(['c1']);
            p.set('refs', arr);
            doc.getMap('parents').set(id, p);
        };
        x.transact(() => seedParent(x, 'p1'));
        y.transact(() => seedParent(y, 'p2'));
        Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
        Y.applyUpdate(y, Y.encodeStateAsUpdate(x));

        // A converged order array + the shared child, seeded on x and synced to y.
        x.transact(() => {
            x.getArray<string>('order').push(['p1', 'p2']);
            x.getMap('children').set('c1', new Y.Map());
        });
        Y.applyUpdate(y, Y.encodeStateAsUpdate(x));

        // Precondition: map-key orders really diverge while the order arrays agree.
        expect(Array.from(x.getMap('parents').keys())).not.toEqual(Array.from(y.getMap('parents').keys()));
        expect(x.getArray<string>('order').toArray()).toEqual(y.getArray<string>('order').toArray());

        // Each peer repairs independently, then they exchange the repair updates.
        normalizeParentChildRefs(x, 'parents', 'children', 'refs', 'order');
        normalizeParentChildRefs(y, 'parents', 'children', 'refs', 'order');
        Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
        Y.applyUpdate(y, Y.encodeStateAsUpdate(x));

        // Both land on the same single holder (p2, last in document order) — no mutual deletion.
        expect(refsOf(x, 'p2')).toEqual(['c1']);
        expect(refsOf(x, 'p1')).toEqual([]);
        expect(refsOf(y, 'p2')).toEqual(['c1']);
        expect(refsOf(y, 'p1')).toEqual([]);
    });

    test('is idempotent with an order array — a well-formed doc writes nothing', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c2'] }, ['c1', 'c2'], ['p1', 'p2']);
        const before = Y.encodeStateAsUpdate(doc);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs', 'order');
        expect(refsOf(doc, 'p1')).toEqual(['c1']);
        expect(refsOf(doc, 'p2')).toEqual(['c2']);
        expect(Y.encodeStateAsUpdate(doc).length).toBeGreaterThanOrEqual(before.length);
    });
});
