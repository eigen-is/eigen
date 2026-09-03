import { describe, expect, test } from 'bun:test';
import { parseBinding, readVectorFromDoc, serializeBinding } from '@workspace/lib/vector';
import * as Y from 'yjs';
import {
    addFrameInDoc,
    deleteFrameInDoc,
    duplicateFrameInDoc,
    moveFrameInDoc,
    updateFramesInDoc,
} from '../../../../components/vector/hooks/frame-writes';

function docWithFrames(n: number): { doc: Y.Doc; ids: string[] } {
    const doc = new Y.Doc();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(addFrameInDoc(doc));
    return { doc, ids };
}

function addElement(doc: Y.Doc, id: string, frameId: string, fields: Record<string, unknown> = {}): void {
    doc.transact(() => {
        const map = new Y.Map();
        const record = {
            id,
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            angle: 0,
            index: 'a0',
            frameId,
            ...fields,
        };
        for (const [key, value] of Object.entries(record)) map.set(key, value);
        doc.getMap('elements').set(id, map);
    });
}

describe('frame writes', () => {
    test('frames are appended in fractional-index order at the constant 16:9 size', () => {
        const { doc, ids } = docWithFrames(3);
        const frames = readVectorFromDoc(doc).frames;
        expect(frames.map((f) => f.id)).toEqual(ids);
        expect(frames.every((f) => f.width === 1920 && f.height === 1080)).toBe(true);
    });

    test('addFrame(afterId) inserts between its neighbours', () => {
        const { doc, ids } = docWithFrames(2);
        const mid = addFrameInDoc(doc, ids[0]);
        expect(readVectorFromDoc(doc).frames.map((f) => f.id)).toEqual([ids[0], mid, ids[1]]);
    });

    test('deleting a frame deletes its elements and leaves the others alone', () => {
        const { doc, ids } = docWithFrames(2);
        addElement(doc, 'a', ids[0]);
        addElement(doc, 'b', ids[1]);
        deleteFrameInDoc(doc, ids[0]);
        const scene = readVectorFromDoc(doc);
        expect(scene.frames.map((f) => f.id)).toEqual([ids[1]]);
        expect(scene.elements.map((e) => e.id)).toEqual(['b']);
    });

    test('a delete is ONE transact, so it is one undo step', () => {
        const { doc, ids } = docWithFrames(1);
        addElement(doc, 'a', ids[0]);
        let transactions = 0;
        doc.on('afterTransaction', () => {
            transactions++;
        });
        deleteFrameInDoc(doc, ids[0]);
        expect(transactions).toBe(1);
    });

    test('duplicateFrame clones the frame and re-homes the clones onto it', () => {
        const { doc, ids } = docWithFrames(1);
        addElement(doc, 'a', ids[0]);
        const copy = duplicateFrameInDoc(doc, ids[0]);
        const scene = readVectorFromDoc(doc);
        expect(scene.frames.map((f) => f.id)).toEqual([ids[0], copy]);
        const cloned = scene.elements.filter((el) => el.frameId === copy);
        expect(cloned.length).toBe(1);
        expect(cloned[0].id).not.toBe('a');
    });

    test('duplicateFrame copies the name and background, and clones keep their frame-relative spot', () => {
        const { doc, ids } = docWithFrames(1);
        updateFramesInDoc(doc, [
            { id: ids[0], fields: { name: 'Cover', background: '{"type":"solid","color":"#ffffff"}' } },
        ]);
        addElement(doc, 'a', ids[0], { x: 40, y: 60 });
        const copy = duplicateFrameInDoc(doc, ids[0]);
        const scene = readVectorFromDoc(doc);
        const clone = scene.frames.find((f) => f.id === copy);
        expect(clone?.name).toBe('Cover');
        expect(clone?.background).toBe('{"type":"solid","color":"#ffffff"}');
        expect(scene.elements.find((el) => el.frameId === copy)).toMatchObject({ x: 40, y: 60 });
    });

    test('duplicateFrame remaps an arrow bound inside the frame onto the copies', () => {
        const { doc, ids } = docWithFrames(1);
        addElement(doc, 'shape', ids[0]);
        addElement(doc, 'arr', ids[0], {
            type: 'arrow',
            points: '[[0,0],[10,10]]',
            startBinding: serializeBinding({ elementId: 'shape', fixedPoint: [0.5, 0.5] }),
        });
        const copy = duplicateFrameInDoc(doc, ids[0]);
        const scene = readVectorFromDoc(doc);
        const clonedShape = scene.elements.find((el) => el.frameId === copy && el.type === 'rectangle');
        const clonedArrow = scene.elements.find((el) => el.frameId === copy && el.type === 'arrow');
        const binding = clonedArrow?.type === 'arrow' ? parseBinding(clonedArrow.startBinding) : null;
        expect(binding?.elementId).toBe(clonedShape?.id ?? '');
    });

    test('moveFrame reorders without touching elements', () => {
        const { doc, ids } = docWithFrames(3);
        addElement(doc, 'a', ids[2]);
        moveFrameInDoc(doc, ids[2], null);
        const scene = readVectorFromDoc(doc);
        expect(scene.frames.map((f) => f.id)).toEqual([ids[2], ids[0], ids[1]]);
        expect(scene.elements.map((el) => el.frameId)).toEqual([ids[2]]);
    });

    test('moveFrame keeps the frame Y.Map, so a concurrent rename survives the move', () => {
        const { doc, ids } = docWithFrames(2);
        updateFramesInDoc(doc, [{ id: ids[0], fields: { name: 'Cover' } }]);
        const before = doc.getMap('frames').get(ids[0]);
        moveFrameInDoc(doc, ids[0], ids[1]);
        // The same object: a delete-and-recreate drops a peer's concurrent rename on merge.
        expect(doc.getMap('frames').get(ids[0])).toBe(before);
        expect(readVectorFromDoc(doc).frames.find((f) => f.id === ids[0])?.name).toBe('Cover');
    });

    test('moving a frame one place forward is not a no-op', () => {
        const { doc, ids } = docWithFrames(3);
        moveFrameInDoc(doc, ids[0], ids[1]);
        expect(readVectorFromDoc(doc).frames.map((f) => f.id)).toEqual([ids[1], ids[0], ids[2]]);
    });

    test('updateFrames writes only allow-listed keys', () => {
        const { doc, ids } = docWithFrames(1);
        updateFramesInDoc(doc, [
            { id: ids[0], fields: { name: 'Cover', background: '{"type":"solid","color":"#ffffff"}' } },
        ]);
        const frame = readVectorFromDoc(doc).frames[0];
        expect(frame.name).toBe('Cover');
        expect(frame.background).toBe('{"type":"solid","color":"#ffffff"}');
        expect(doc.getMap('frames').get(ids[0]) instanceof Y.Map).toBe(true);
    });

    test('a stored width/height is ignored — the size is a constant', () => {
        const { doc, ids } = docWithFrames(1);
        doc.transact(() => {
            const map = doc.getMap('frames').get(ids[0]);
            if (map instanceof Y.Map) map.set('width', 42);
        });
        expect(readVectorFromDoc(doc).frames[0].width).toBe(1920);
    });
});
