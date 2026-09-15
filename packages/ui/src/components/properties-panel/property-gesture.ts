import { createContext, useContext } from 'react';

// Opens one undo step and returns its release. Every control in the panel writes on every change — a
// slider per drag frame, a number field per keystroke — so the control opens a gesture on its first
// write and releases it on commit or blur, and ⌘Z reverts the whole edit rather than one digit of it.
// The host supplies it because only the host knows the undo stack; the panel just spans the edit.
export type BeginGesture = () => () => void;

// No host gesture: every write stands alone, which is the behaviour of a panel over an undo stack
// that has no hold to offer (docs' ProseMirror history).
const NO_GESTURE: BeginGesture = () => () => {};

export const PropertyGestureContext = createContext<BeginGesture>(NO_GESTURE);

export function usePropertyGesture(): BeginGesture {
    return useContext(PropertyGestureContext);
}
