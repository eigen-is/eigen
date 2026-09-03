import { describe, expect, test } from 'bun:test';
import { readVectorFromDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { seedDeck } from '../../../components/slides/seed-deck';

describe('seedDeck', () => {
    test('an empty deck gains one slide with a title box on it', () => {
        const doc = new Y.Doc();
        seedDeck(doc);
        const scene = readVectorFromDoc(doc);
        expect(scene.frames).toHaveLength(1);
        expect(scene.elements).toHaveLength(1);
        expect(scene.elements[0].frameId).toBe(scene.frames[0].id);
        expect(scene.elements[0].type).toBe('richtext');
    });

    test('a deck that already has a slide is left alone', () => {
        const doc = new Y.Doc();
        seedDeck(doc);
        const firstId = readVectorFromDoc(doc).frames[0].id;
        seedDeck(doc);
        expect(readVectorFromDoc(doc).frames.map((f) => f.id)).toEqual([firstId]);
    });

    test('the seed is not undoable — a fresh deck cannot be emptied by ⌘Z', () => {
        const doc = new Y.Doc();
        const undoManager = new Y.UndoManager([doc.getMap('elements'), doc.getMap('frames')]);
        seedDeck(doc);
        undoManager.undo();
        expect(readVectorFromDoc(doc).frames).toHaveLength(1);
    });
});
