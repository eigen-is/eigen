import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { NORMALIZE_ORIGIN, normalizeParentChildRefs } from './normalize-refs';

// Build a doc shaped like slides/stickies: a `parents` map of Y.Maps each holding a `refs` Y.Array of
// child ids, plus a `children` map of the children themselves.
function makeDoc(parents: Record<string, string[]>, children: string[]): Y.Doc {
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
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
        expect(refsOf(doc, 'p1')).toEqual([]);
        expect(refsOf(doc, 'p2')).toEqual(['c1']);
    });

    test('keeps last across three parents (deletes from every earlier one)', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'], p3: ['c1'] }, ['c1']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
        expect(refsOf(doc, 'p1')).toEqual([]);
        expect(refsOf(doc, 'p2')).toEqual([]);
        expect(refsOf(doc, 'p3')).toEqual(['c1']);
    });

    test('re-homes an orphaned child to the FIRST parent', () => {
        const doc = makeDoc({ p1: [], p2: [] }, ['orphan']);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
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
        expect(() => normalizeParentChildRefs(doc, 'parents', 'children', 'refs')).not.toThrow();
        expect(refsOf(doc, 'p2')).toEqual(['c1']);
    });

    test('is idempotent — a well-formed doc is left untouched', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c2'] }, ['c1', 'c2']);
        const before = Y.encodeStateAsUpdate(doc);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
        // No structural change beyond an empty transaction: refs identical.
        expect(refsOf(doc, 'p1')).toEqual(['c1']);
        expect(refsOf(doc, 'p2')).toEqual(['c2']);
        // A second run over an already-clean doc makes no writes.
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
        expect(refsOf(doc, 'p1')).toEqual(['c1']);
        expect(Y.encodeStateAsUpdate(doc).length).toBeGreaterThanOrEqual(before.length);
    });

    test('repairs run under NORMALIZE_ORIGIN — an UndoManager (default trackedOrigins) ignores them', () => {
        const doc = makeDoc({ p1: ['c1'], p2: ['c1'] }, ['c1']);
        const um = new Y.UndoManager([doc.getMap('parents')]);
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
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
        normalizeParentChildRefs(doc, 'parents', 'children', 'refs');
        expect(seenOrigin).toBe(NORMALIZE_ORIGIN);
    });
});
