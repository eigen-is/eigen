import { type RefObject, useEffect } from 'react';

export function useScrollToIndex(containerRef: RefObject<HTMLElement | null>, index: number) {
    useEffect(() => {
        const container = containerRef.current;
        if (!container || index < 0) return;
        const item = container.children[index] as HTMLElement | undefined;
        if (!item) return;
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        if (itemTop < container.scrollTop) {
            container.scrollTop = itemTop;
        } else if (itemBottom > container.scrollTop + container.clientHeight) {
            container.scrollTop = itemBottom - container.clientHeight;
        }
    }, [containerRef, index]);
}
