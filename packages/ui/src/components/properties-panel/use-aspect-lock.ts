import { useState } from 'react';

// Ephemeral per-element aspect-lock state for TransformSection. The same ON/OFF the checkbox shows is
// fed by the host into ObjectTransform's resizeMode, so it must live ONE level up from both the panel
// and the canvas. It is NEVER stored on an element.
//
// The default follows the selection: image-only selections start CHECKED (binding), everything else
// UNCHECKED (recommendation). A toggle is remembered per element id for as long as the editor hosting
// the panel is mounted, so unchecking an image, clicking away and clicking it again finds it still
// unchecked. A selection shows its default until every element in it remembers the same choice.
export function useAspectLock(
    selectedIds: readonly string[],
    defaultLocked: boolean,
): [boolean, (locked: boolean) => void] {
    const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
    const [first, ...rest] = selectedIds;
    const choice = first === undefined ? undefined : choices.get(first);
    const locked = choice !== undefined && rest.every((id) => choices.get(id) === choice) ? choice : defaultLocked;

    const setLocked = (next: boolean) => {
        setChoices((prev) => {
            const updated = new Map(prev);
            for (const id of selectedIds) updated.set(id, next);
            return updated;
        });
    };
    return [locked, setLocked];
}
