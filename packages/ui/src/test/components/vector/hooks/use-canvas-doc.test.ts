import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { holdCapture } from '../../../../components/vector/hooks/use-canvas-doc';

function undoManager(): Y.UndoManager {
    const doc = new Y.Doc();
    return new Y.UndoManager(doc.getMap('elements'));
}

describe('holdCapture', () => {
    test('holds the capture window open and gives the original timeout back', () => {
        const manager = undoManager();
        const original = manager.captureTimeout;

        const release = holdCapture(manager);
        expect(manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);

        release();
        expect(manager.captureTimeout).toBe(original);
    });

    test('a second release is a no-op, so a doubly-ended gesture cannot re-arm the hold', () => {
        const manager = undoManager();
        const original = manager.captureTimeout;

        const release = holdCapture(manager);
        release();
        release();
        expect(manager.captureTimeout).toBe(original);
    });

    test('a nested hold is a no-op: releasing it leaves the outer hold in charge', () => {
        const manager = undoManager();
        const original = manager.captureTimeout;

        const first = holdCapture(manager);
        const second = holdCapture(manager);
        second();
        expect(manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);

        first();
        expect(manager.captureTimeout).toBe(original);
    });

    test('no undo manager yields a release that does nothing', () => {
        expect(() => holdCapture(null)()).not.toThrow();
    });
});
