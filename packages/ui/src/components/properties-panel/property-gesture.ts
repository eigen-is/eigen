import { undoChord } from '@workspace/ui/lib/undoChord';
import type { KeyboardEvent } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type * as Y from 'yjs';

// Opens one undo step and returns its release. Every control in the panel writes on every change — a
// slider per drag frame, a number field per keystroke — so the control opens a gesture on its first
// write and releases it on commit or blur, and ⌘Z reverts the whole edit rather than one digit of it.
// The host supplies it on PropertyGestureContext because only the host knows the undo stack; the
// control just spans the edit.
export type BeginGesture = () => () => void;

// Default: no host gesture, so every write stands alone — the behaviour of a panel over an undo stack
// that has no hold to offer (docs' ProseMirror history).
const NO_GESTURE: BeginGesture = () => () => {};

export const PropertyGestureContext = createContext<BeginGesture>(NO_GESTURE);

// The host's undo and redo, for the fields that write as the user types: what such a field shows is already the
// document's, so ⌘Z in it takes back the document's step. Left to the browser, the field's own undo walks the text
// back a character at a time, writing each one. A host whose undo hotkey fires in fields too (the canvas) has none.
export type PropertyHistory = { undo: () => void; redo: () => void };

export const PropertyHistoryContext = createContext<PropertyHistory | null>(null);

// The hold every panel control that writes as the user goes runs on: `hold` opens the gesture on the
// first write and is idempotent, `end` releases it on a commit or a blur and may be called again.
// Released on unmount too — a gesture the control never sees end (Escape mid-edit deselects and
// unmounts the section, and so does a peer deleting the element) would leave the hold open, and every
// later edit would merge into that one undo step. `undoKey` ends the edit on ⌘Z, ⇧⌘Z or Ctrl+Y and runs
// the host's history, if it has one; it returns whether the key was one, so the field drops its draft
// and shows what the undo left.
export function useHeldGesture(): {
    hold: () => void;
    end: () => void;
    undoKey: (e: KeyboardEvent) => boolean;
} {
    const beginGesture = useContext(PropertyGestureContext);
    const history = useContext(PropertyHistoryContext);
    const release = useRef<(() => void) | null>(null);

    const hold = useCallback(() => {
        release.current ??= beginGesture();
    }, [beginGesture]);
    const end = useCallback(() => {
        release.current?.();
        release.current = null;
    }, []);
    useEffect(() => end, [end]);
    const undoKey = useCallback(
        (e: KeyboardEvent) => {
            const chord = undoChord(e);
            if (!chord) return false;
            end();
            if (history) {
                e.preventDefault();
                history[chord]();
            }
            return true;
        },
        [end, history],
    );

    return { hold, end, undoKey };
}

// One discrete op = one undo step. Y.UndoManager merges everything inside a 500ms capture window, so a
// discrete op seals on BOTH sides: nothing that happened just before it (a nudge) and nothing that
// follows joins its step. The canvas' element ops, the panel's writes and the frame ops all go through
// this — a gesture that deliberately coalesces (a nudge, a keystroke) simply doesn't call it.
export function sealed<T>(undoManager: Y.UndoManager | null, op: () => T): T {
    // A gesture is holding the window open (holdCapture), and it owns the step: sealing a write inside
    // it would split one typed number into a step per digit.
    if (undoManager?.captureTimeout === Number.POSITIVE_INFINITY) return op();
    undoManager?.stopCapturing();
    const result = op();
    undoManager?.stopCapturing();
    return result;
}

// The continuous counterpart of `sealed`: one GESTURE = one undo step, however long it lasts. A
// slider drag writes live so the canvas updates under the pointer, and merely leaving those writes
// unsealed is not enough — Y.UndoManager only merges changes that land within `captureTimeout` of
// each other, so a slow drag, or a pause to look at the result, silently splits into several steps.
// Hold the window open for the gesture instead, and seal at both ends. Returns the release, which is
// idempotent: a gesture can end more than once (Radix commits AND the pointer-up fires, or an unmount
// cleanup follows a commit), and a second restore would write back the Infinity the first one left.
export function holdCapture(undoManager: Y.UndoManager | null): () => void {
    if (!undoManager) return () => {};
    const previous = undoManager.captureTimeout;
    // A hold is already open, so this one is a no-op: capturing Infinity as the timeout to restore would
    // make the inner release leave the window open forever, and sealing here would split the outer
    // gesture's step in two. The outer hold stays in charge.
    if (previous === Number.POSITIVE_INFINITY) return () => {};
    undoManager.stopCapturing();
    undoManager.captureTimeout = Number.POSITIVE_INFINITY;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        undoManager.captureTimeout = previous;
        undoManager.stopCapturing();
    };
}
