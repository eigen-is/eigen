import { describe, expect, test } from 'bun:test';
import { DEFAULT_SCENE_META, parseBackgroundFill, readVectorFromDoc, writeFrameInDoc } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { seedDeck } from '../../../components/slides/seed-deck';

describe('seedDeck', () => {
    test('an empty deck gains one slide with a title box on it', () => {
        const doc = new Y.Doc();
        seedDeck(doc);
        const scene = readVectorFromDoc(doc);
        expect(scene.frames).toHaveLength(1);
        expect(scene.elements).toHaveLength(1);
        const welcome = scene.elements[0];
        expect(welcome.frameId).toBe(scene.frames[0].id);
        expect(welcome.type).toBe('richtext');
        // A new deck opens on the seed color with white text on it. Only the seeded slide: one added
        // with + keeps the shared DEFAULT_FRAME_BACKGROUND.
        expect(parseBackgroundFill(scene.frames[0].background)).toEqual({ type: 'solid', color: '#f6339a' });
        expect(welcome.type === 'richtext' && welcome.color).toBe('#ffffff');
    });

    // A deck that stores no width reads as an older deck's 10 in, so a new one writes its own.
    test("a new deck writes its width, PowerPoint's 13.33 in", () => {
        const doc = new Y.Doc();
        seedDeck(doc);
        expect(doc.getMap('meta').get('slideWidth')).toBe(960);
        expect(readVectorFromDoc(doc).meta.slideWidth).toBe(DEFAULT_SCENE_META.slideWidth);
    });

    // A pptx with no slides imports its width and nothing to show, so the deck is seeded at the pptx's width.
    test('a deck that stores its width keeps it', () => {
        const doc = new Y.Doc();
        doc.getMap('meta').set('slideWidth', 720);
        seedDeck(doc);
        expect(readVectorFromDoc(doc).frames).toHaveLength(1);
        expect(doc.getMap('meta').get('slideWidth')).toBe(720);
    });

    test('a deck that already has a slide is left alone', () => {
        const doc = new Y.Doc();
        seedDeck(doc);
        const firstId = readVectorFromDoc(doc).frames[0].id;
        seedDeck(doc);
        expect(readVectorFromDoc(doc).frames.map((f) => f.id)).toEqual([firstId]);
        // An older deck keeps reading at the width it was made at.
        const older = new Y.Doc();
        writeFrameInDoc(older, { id: 'fr-older', index: 'a0' });
        seedDeck(older);
        expect(older.getMap('meta').has('slideWidth')).toBe(false);
    });

    test('two peers seeding the same empty deck converge on one title slide', () => {
        const alice = new Y.Doc();
        const bob = new Y.Doc();
        seedDeck(alice);
        seedDeck(bob);
        Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
        Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
        for (const scene of [readVectorFromDoc(alice), readVectorFromDoc(bob)]) {
            expect(scene.frames).toHaveLength(1);
            expect(scene.elements).toHaveLength(1);
            expect(scene.elements[0].frameId).toBe(scene.frames[0].id);
        }
    });

    test('the seed is not undoable — a fresh deck cannot be emptied by ⌘Z', () => {
        const doc = new Y.Doc();
        const undoManager = new Y.UndoManager([doc.getMap('elements'), doc.getMap('frames')]);
        seedDeck(doc);
        undoManager.undo();
        expect(readVectorFromDoc(doc).frames).toHaveLength(1);
    });
});
