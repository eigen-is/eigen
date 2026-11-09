// Keeps the highlighted row of a keyboard-driven list in view, such as a suggestion list's, by scrolling its
// container just far enough to show the row at `index`. A negative index, for no highlight, scrolls nothing.

import type { RefObject } from 'react';
import { useEffect } from 'react';

export function useScrollToIndex(containerRef: RefObject<HTMLElement | null>, index: number) {
    useEffect(() => {
        const container = containerRef.current;
        if (!container || index < 0) return;
        const item = container.children[index];
        if (!(item instanceof HTMLElement)) return;
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        if (itemTop < container.scrollTop) {
            container.scrollTop = itemTop;
        } else if (itemBottom > container.scrollTop + container.clientHeight) {
            container.scrollTop = itemBottom - container.clientHeight;
        }
    }, [containerRef, index]);
}
