import { type RefCallback, type RefObject, useCallback, useState } from 'react';

type ElementSize = { width: number; height: number };

// Tracks a node's content box, for the surfaces that lay themselves out from their own measured width
// (the drive grid's column count, the doc page's scale, a frame's shrink-to-fit).
//
// A callback ref, not a ref + mount effect: the observer is then born and dies with the node, so a
// surface that mounts late or remounts is still measured. `ref` is filled alongside for the callers
// that also need the node for something else (a scroll container's click target, a virtualizer).
//
// A 0x0 reading is dropped and `size` keeps the last real one: a hidden surface (the mobile pane)
// measures zero while it is away, and collapsing the layout and rebuilding it is a visible flip.
export function useElementSize<T extends Element>(ref?: RefObject<T | null>): [RefCallback<T>, ElementSize] {
    const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

    const setElement = useCallback(
        (el: T | null) => {
            if (ref) ref.current = el;
            if (!el) return;
            const observer = new ResizeObserver(([entry]) => {
                const { width, height } = entry.contentRect;
                if (width === 0 && height === 0) return;
                setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
            });
            observer.observe(el);
            return () => {
                if (ref) ref.current = null;
                observer.disconnect();
            };
        },
        [ref],
    );

    return [setElement, size];
}
