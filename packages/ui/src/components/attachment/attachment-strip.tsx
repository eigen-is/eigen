// One sideways-scrolling row of attachment chips, the layout every file list on a card, a chat
// message or a mail uses, its composers included. The row stays one chip high however many files
// there are, so twenty screenshots scroll instead of pushing the dialog or message out of shape.
// An edge that hides more chips fades out, so the row reads as scrollable.

import type { ComponentProps } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

const FADE = '1.5rem';

function edgeMask(start: boolean, end: boolean): string | undefined {
    if (!start && !end) return undefined;
    const from = start ? `transparent, black ${FADE}` : 'black';
    const to = end ? `black calc(100% - ${FADE}), transparent` : 'black';
    return `linear-gradient(to right, ${from}, ${to})`;
}

export function AttachmentStrip({ children, className, style, ...props }: ComponentProps<'div'>) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: false, end: false });

    const measure = useCallback(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const start = el.scrollLeft > 1;
        const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }, []);

    // The inner row is observed too: a chip added in a composer, or a thumbnail that loads late,
    // widens the content without resizing the scroller.
    useEffect(() => {
        const observer = new ResizeObserver(measure);
        if (scrollerRef.current) observer.observe(scrollerRef.current);
        if (rowRef.current) observer.observe(rowRef.current);
        return () => observer.disconnect();
    }, [measure]);

    const mask = edgeMask(edges.start, edges.end);

    return (
        <div
            ref={scrollerRef}
            onScroll={measure}
            className={cn(
                'overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1.5 [scrollbar-width:thin]',
                className,
            )}
            style={{ ...style, maskImage: mask, WebkitMaskImage: mask }}
            {...props}
        >
            <div ref={rowRef} className="flex w-max items-center gap-2">
                {children}
            </div>
        </div>
    );
}
