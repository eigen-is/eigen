import { useEffect, useState } from 'react';

// Ephemeral per-selection aspect-lock state for TransformSection. The same
// ON/OFF the checkbox shows is fed by the host into ObjectTransform's resizeMode, so it must live
// ONE level up from both the panel and the canvas. It is NEVER stored on an element.
//
// The default follows the selection: image-only selections start CHECKED (binding), everything else
// UNCHECKED (recommendation). A manual toggle sticks until the selection changes, at which point the
// state resets to the fresh selection's default. `selectionKey` is any string that changes when the
// selection identity changes (e.g. the sorted/joined ids).
export function useAspectLock(selectionKey: string, defaultLocked: boolean): [boolean, (locked: boolean) => void] {
    const [locked, setLocked] = useState(defaultLocked);
    // Selection (or its default) changed → drop any manual override, adopt the new default.
    useEffect(() => {
        setLocked(defaultLocked);
    }, [selectionKey, defaultLocked]);
    return [locked, setLocked];
}
