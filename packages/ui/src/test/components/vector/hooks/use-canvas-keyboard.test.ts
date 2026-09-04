import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createNudgeBurst, endsNudgeBurst } from '../../../../components/vector/hooks/use-canvas-keyboard';

// One element whose x the arrow keys step, written the way `updateElements` writes it. The capture
// timeout is set to 0 so every write lands OUTSIDE Y.UndoManager's merge window — the canvas' real
// behaviour once a re-render pushes two taps further apart than the default 500 ms.
function scene() {
    const doc = new Y.Doc();
    const elements = doc.getMap<Y.Map<unknown>>('elements');
    const el = new Y.Map<unknown>();
    doc.transact(() => {
        el.set('x', 100);
        elements.set('e1', el);
    });
    const undoManager = new Y.UndoManager(elements);
    undoManager.captureTimeout = 0;
    undoManager.clear();
    return {
        undoManager,
        nudge: (dx: number) => doc.transact(() => el.set('x', (el.get('x') as number) + dx)),
        x: () => el.get('x') as number,
    };
}

describe('createNudgeBurst', () => {
    test('a run of nudges is one undo step even when the taps land outside the capture window', () => {
        const { undoManager, nudge, x } = scene();
        const burst = createNudgeBurst(undoManager);

        for (let i = 0; i < 5; i++) {
            burst.begin();
            nudge(1);
        }
        burst.end();
        expect(x()).toBe(105);

        undoManager.undo();
        expect(x()).toBe(100);
        expect(undoManager.canUndo()).toBe(false);
    });

    test('ending the run seals it, so the next op is its own undo step', () => {
        const { undoManager, nudge, x } = scene();
        const burst = createNudgeBurst(undoManager);

        burst.begin();
        nudge(1);
        burst.end();
        nudge(10);

        undoManager.undo();
        expect(x()).toBe(101);
        undoManager.undo();
        expect(x()).toBe(100);
    });

    test('a run begins sealed, so it never swallows the op before it', () => {
        const { undoManager, nudge, x } = scene();
        const burst = createNudgeBurst(undoManager);

        // Wide enough that the op before the run WOULD swallow it if the run began unsealed.
        undoManager.captureTimeout = 10_000;
        nudge(10);
        burst.begin();
        nudge(1);
        burst.end();

        undoManager.undo();
        expect(x()).toBe(110);
    });

    test('a second end is a no-op, so a torn-down canvas cannot re-arm the hold', () => {
        const { undoManager, nudge, x } = scene();
        const burst = createNudgeBurst(undoManager);

        burst.begin();
        nudge(1);
        burst.end();
        burst.end();
        expect(undoManager.captureTimeout).toBe(0);

        burst.begin();
        nudge(1);
        burst.end();
        undoManager.undo();
        expect(x()).toBe(101);
    });

    test('no undo manager still nudges', () => {
        const burst = createNudgeBurst(null);
        expect(() => {
            burst.begin();
            burst.end();
        }).not.toThrow();
    });
});

describe('endsNudgeBurst', () => {
    test('the arrows and the modifiers that qualify them keep the run open', () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift', 'Meta', 'Control', 'Alt']) {
            expect(endsNudgeBurst(key)).toBe(false);
        }
    });

    test('anything else ends it', () => {
        for (const key of ['z', 'Escape', 'Delete', 'Backspace', 'v', 'Enter']) {
            expect(endsNudgeBurst(key)).toBe(true);
        }
    });
});
