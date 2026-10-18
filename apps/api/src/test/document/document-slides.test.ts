import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_SCENE_META,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    serializeBinding,
    type VectorElement,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { appendSlidesUpdateToYjs, writeSlidesUpdateToYjs } from '../../lib/document/slides';

// What the transform process hands over: a scratch deck encoded as one update.
function updateOf(build: (doc: Y.Doc) => void): Uint8Array {
    const doc = new Y.Doc();
    doc.transact(() => build(doc));
    return Y.encodeStateAsUpdate(doc);
}

// The update as the reader sees it, for comparing what an append wrote with what it was given.
function scratchOf(update: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return doc;
}

// A raw Y.Map write that bypasses the writer's allow-list, the way a hostile pptx could shape one.
function rawEntry(doc: Y.Doc, root: string, key: string, fields: Record<string, unknown>): void {
    const map = new Y.Map();
    for (const [field, value] of Object.entries(fields)) map.set(field, value);
    doc.getMap(root).set(key, map);
}

const BOX = { x: 100, y: 100, width: 400, height: 200 };

// Two slides: a rectangle and an arrow bound to it (and to a shape the update doesn't hold) on the first,
// an ellipse on the second.
const DECK_UPDATE = updateOf((doc) => {
    writeFrameInDoc(doc, { id: 'u1', index: 'a0', name: 'One' });
    writeFrameInDoc(doc, { id: 'u2', index: 'a1', name: 'Two' });
    writeElementInDoc(doc, { type: 'rectangle', frameId: 'u1', ...BOX, seed: 5 }, 'a0', SLIDES_STYLE_DEFAULTS, 'r');
    writeElementInDoc(
        doc,
        {
            type: 'arrow',
            frameId: 'u1',
            x: 500,
            y: 200,
            width: 200,
            height: 0,
            points: '[[0,0],[200,0]]',
            startBinding: serializeBinding({ elementId: 'r', fixedPoint: [1, 0.5] }),
            endBinding: serializeBinding({ elementId: 'ghost', fixedPoint: [0, 0.5] }),
            commentCardIds: '["card"]',
        },
        'a1',
        SLIDES_STYLE_DEFAULTS,
        'ar',
    );
    writeElementInDoc(doc, { type: 'ellipse', frameId: 'u2', ...BOX }, 'a2', SLIDES_STYLE_DEFAULTS, 'e');
    doc.getMap('meta').set('background', '#123456');
    doc.getMap('meta').set('slideSize', '4:3');
});

// A deck someone already works in: two slides with one element each, and its own background.
function existingDeck(): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
        writeFrameInDoc(doc, { id: 't1', index: 'a0' });
        writeFrameInDoc(doc, { id: 't2', index: 'a5' });
        writeElementInDoc(doc, { type: 'richtext', frameId: 't1', ...BOX }, 'a0', SLIDES_STYLE_DEFAULTS, 'old1');
        writeElementInDoc(doc, { type: 'diamond', frameId: 't2', ...BOX }, 'a9', SLIDES_STYLE_DEFAULTS, 'old2');
        doc.getMap('meta').set('background', '#ffffff');
    });
    return doc;
}

// An element as the update holds it, healed by the reader, with the fields an append rewrites set aside.
function content(el: VectorElement): Omit<VectorElement, 'id' | 'index' | 'frameId'> {
    const { id: _id, index: _index, frameId: _frameId, ...rest } = el;
    return rest;
}

describe('document/slides', () => {
    test('an append into an empty deck writes every slide and element in the update order', () => {
        const target = new Y.Doc();
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        const source = readVectorFromDoc(scratchOf(DECK_UPDATE));
        const scene = readVectorFromDoc(target);
        expect(scene.frames.map((f) => f.name)).toEqual(['One', 'Two']);
        expect(scene.elements.map((el) => el.type)).toEqual(['rectangle', 'arrow', 'ellipse']);
        const [rect, , ellipse] = scene.elements;
        expect(rect.frameId).toBe(scene.frames[0].id);
        expect(ellipse.frameId).toBe(scene.frames[1].id);
        expect(content(rect)).toEqual(content(source.elements[0]));
        expect(rect.seed).toBe(5);
    });

    test('an append into a working deck sorts after it, with fresh ids and remapped frames and bindings', () => {
        const target = existingDeck();
        const before = readVectorFromDoc(target);
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        const scene = readVectorFromDoc(target);

        expect(scene.frames.slice(0, 2)).toEqual(before.frames);
        expect(scene.elements.slice(0, 2)).toEqual(before.elements);
        const [newOne, newTwo] = scene.frames.slice(2);
        expect([newOne.name, newTwo.name]).toEqual(['One', 'Two']);
        expect(newOne.index > 'a5').toBe(true);

        const [rect, arrow, ellipse] = scene.elements.slice(2);
        expect(rect.index > 'a9').toBe(true);
        for (const el of [rect, arrow, ellipse]) expect(['r', 'ar', 'e', 'old1', 'old2']).not.toContain(el.id);
        for (const frame of [newOne, newTwo]) expect(['u1', 'u2', 't1', 't2']).not.toContain(frame.id);
        expect([rect.frameId, arrow.frameId, ellipse.frameId]).toEqual([newOne.id, newOne.id, newTwo.id]);
        expect(arrow.type === 'arrow' && arrow.startBinding).toBe(
            serializeBinding({ elementId: rect.id, fixedPoint: [1, 0.5] }),
        );
        expect(arrow.type === 'arrow' && arrow.endBinding).toBe('');
    });

    test('an imported element starts with no comment cards', () => {
        const target = existingDeck();
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        expect(readVectorFromDoc(target).elements.every((el) => el.commentCardIds === '')).toBe(true);
    });

    test('two appends of one update write two copies, never one id twice', () => {
        const target = new Y.Doc();
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        const scene = readVectorFromDoc(target);
        expect(new Set(scene.frames.map((f) => f.id)).size).toBe(4);
        expect(new Set(scene.elements.map((el) => el.id)).size).toBe(6);
        expect(scene.frames.map((f) => f.name)).toEqual(['One', 'Two', 'One', 'Two']);
    });

    test('the existing records are the same Y.Maps, unchanged, so open undo stacks and comments stay valid', () => {
        const target = existingDeck();
        const elements = target.getMap('elements');
        const frames = target.getMap('frames');
        const kept = [elements.get('old1'), elements.get('old2'), frames.get('t1'), frames.get('t2')];
        const json = kept.map((map) => (map instanceof Y.Map ? map.toJSON() : null));
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        const after = [elements.get('old1'), elements.get('old2'), frames.get('t1'), frames.get('t2')];
        for (const [i, map] of after.entries()) {
            expect(map).toBe(kept[i]);
            expect(map instanceof Y.Map ? map.toJSON() : null).toEqual(json[i]);
        }
    });

    test('the whole append is one transaction', () => {
        const target = existingDeck();
        let transactions = 0;
        target.on('afterTransaction', () => {
            transactions++;
        });
        appendSlidesUpdateToYjs(target, DECK_UPDATE);
        expect(transactions).toBe(1);
        const fresh = new Y.Doc();
        let freshTransactions = 0;
        fresh.on('afterTransaction', () => {
            freshTransactions++;
        });
        writeSlidesUpdateToYjs(fresh, DECK_UPDATE);
        expect(freshTransactions).toBe(1);
    });

    test('Convert carries the update meta; Import leaves the target meta alone', () => {
        const converted = new Y.Doc();
        writeSlidesUpdateToYjs(converted, DECK_UPDATE);
        expect(converted.getMap('meta').toJSON()).toEqual({ background: '#123456', slideSize: '4:3' });

        const imported = existingDeck();
        appendSlidesUpdateToYjs(imported, DECK_UPDATE);
        expect(imported.getMap('meta').toJSON()).toEqual({ background: '#ffffff' });
    });

    test('a malformed record is healed or dropped exactly as the reader does it', () => {
        const update = updateOf((doc) => {
            rawEntry(doc, 'frames', 'f-ok', { id: 'f-ok', index: 'a0', name: 'Ok', background: 'not json' });
            rawEntry(doc, 'frames', 'f-noid', { index: 'a1', name: 'No id' });
            rawEntry(doc, 'frames', 'f-badindex', { id: 'f-badindex', index: 42, name: 7 });
            doc.getMap('frames').set('f-scalar', 'not a map');
            rawEntry(doc, 'elements', 'huge', {
                id: 'huge',
                type: 'rectangle',
                index: 'a0',
                frameId: 'f-ok',
                x: 1e15,
                y: Number.NaN,
                width: -5,
                height: 'tall',
                strokeWidth: 1e9,
                strokeColor: 'url(javascript:x)',
                seed: 0,
            });
            rawEntry(doc, 'elements', 'bogus', { id: 'bogus', type: 'script', index: 'a1', frameId: 'f-ok' });
            rawEntry(doc, 'elements', 'noid', { type: 'rectangle', index: 'a2', frameId: 'f-ok' });
            rawEntry(doc, 'elements', 'lost', { id: 'lost', type: 'ellipse', index: 'zzz~', frameId: 'nowhere' });
            doc.getMap('elements').set('scalar', 12);
            doc.getMap('meta').set('background', 'url(javascript:x)');
            doc.getMap('meta').set('onload', 'x');
        });
        const source = readVectorFromDoc(scratchOf(update));
        const target = new Y.Doc();
        writeSlidesUpdateToYjs(target, update);
        const scene = readVectorFromDoc(target);

        expect(scene.frames.map(({ id: _id, index: _index, ...rest }) => rest)).toEqual(
            source.frames.map(({ id: _id, index: _index, ...rest }) => rest),
        );
        expect(scene.elements.map(content)).toEqual(source.elements.map(content));
        expect(scene.elements.map((el) => el.type)).toEqual(['rectangle', 'ellipse']);
        const sourceIndexOf = new Map(source.frames.map((f, i) => [f.id, i]));
        for (const [i, el] of scene.elements.entries()) {
            expect(scene.frames.findIndex((f) => f.id === el.frameId)).toBe(
                sourceIndexOf.get(source.elements[i].frameId) ?? -1,
            );
        }

        // The stored records, not a second read: the reader would heal a raw copy of the update all over again.
        const stored = Object.values(target.getMap('elements').toJSON());
        expect(stored.map((record) => record.type).sort()).toEqual(['ellipse', 'rectangle']);
        expect(stored.find((record) => record.type === 'rectangle')).toMatchObject({
            x: 1_000_000,
            y: 0,
            width: 0,
            height: 0,
            strokeWidth: 100,
        });
        expect(JSON.stringify(stored)).not.toContain('javascript');
        expect(target.getMap('meta').toJSON()).toEqual(DEFAULT_SCENE_META);

        const imported = existingDeck();
        appendSlidesUpdateToYjs(imported, update);
        expect(imported.getMap('meta').toJSON()).toEqual({ background: '#ffffff' });
    });

    test('an update with elements but no slides adds nothing', () => {
        const update = updateOf((doc) => {
            writeElementInDoc(doc, { type: 'rectangle', ...BOX }, 'a0', SLIDES_STYLE_DEFAULTS, 'r');
        });
        const target = existingDeck();
        const before = readVectorFromDoc(target);
        appendSlidesUpdateToYjs(target, update);
        expect(readVectorFromDoc(target)).toEqual(before);
    });
});
