import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

// Opens one undo step and returns its release. Every control in the panel writes on every change — a
// slider per drag frame, a number field per keystroke — so the control opens a gesture on its first
// write and releases it on commit or blur, and ⌘Z reverts the whole edit rather than one digit of it.
// The host supplies it because only the host knows the undo stack; the panel just spans the edit.
export type BeginGesture = () => () => void;

// No host gesture: every write stands alone, which is the behaviour of a panel over an undo stack
// that has no hold to offer (docs' ProseMirror history).
export const NO_GESTURE: BeginGesture = () => () => {};

export const PropertyGestureContext = createContext<BeginGesture>(NO_GESTURE);

// The hold every panel control that writes as the user goes runs on: `hold` opens the gesture on the
// first write and is idempotent, `end` releases it on a commit or a blur and may be called again.
// Released on unmount too — a gesture the control never sees end (Escape mid-edit deselects and
// unmounts the section, and so does a peer deleting the element) would leave the hold open, and every
// later edit would merge into that one undo step.
export function useHeldGesture(): { hold: () => void; end: () => void } {
    const beginGesture = useContext(PropertyGestureContext);
    const release = useRef<(() => void) | null>(null);

    const hold = useCallback(() => {
        release.current ??= beginGesture();
    }, [beginGesture]);
    const end = useCallback(() => {
        release.current?.();
        release.current = null;
    }, []);
    useEffect(() => end, [end]);

    return { hold, end };
}
