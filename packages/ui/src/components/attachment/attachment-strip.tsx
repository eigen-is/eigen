// One sideways-scrolling row of attachment chips, the layout every file list on a card, a chat message or a mail
// uses, its composers included. The row stays one chip high however many files there are, so twenty screenshots
// scroll instead of pushing the dialog or message out of shape. It scrolls like the site's carousel: by touch, by
// dragging it with the mouse, or with a previous or next button on an edge that hides more chips, which also fades.

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDragScroll } from '../../hooks/use-drag-scroll';
import { cn } from '../../lib/utils';
import { Button } from '../button';

const FADE = '1.5rem';
// A button steps most of the visible width, so the chip cut off at the edge is still in view after the step.
const STEP_FRACTION = 0.8;

export function AttachmentStrip({ children, className, ...props }: ComponentProps<'div'>) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: false, end: false });
    const drag = useDragScroll();

    const measure = useCallback(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const start = el.scrollLeft > 1;
        const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }, []);

    // The inner row is observed too: a chip added in a composer, or a thumbnail that loads late, widens the content
    // without resizing the scroller.
    useEffect(() => {
        const observer = new ResizeObserver(measure);
        if (scrollerRef.current) observer.observe(scrollerRef.current);
        if (rowRef.current) observer.observe(rowRef.current);
        return () => observer.disconnect();
    }, [measure]);

    const step = (direction: 1 | -1) => {
        const el = scrollerRef.current;
        if (!el) return;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollBy({ left: direction * el.clientWidth * STEP_FRACTION, behavior: reduceMotion ? 'auto' : 'smooth' });
    };

    const mask = edgeMask(edges.start, edges.end);

    return (
        <div className={className} {...props}>
            <div className="relative">
                <div
                    ref={scrollerRef}
                    onScroll={measure}
                    data-dragging={drag.dragging || undefined}
                    className="overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] data-dragging:cursor-grabbing data-dragging:select-none data-dragging:**:cursor-grabbing"
                    style={{ maskImage: mask, WebkitMaskImage: mask }}
                    {...drag.handlers}
                >
                    <div ref={rowRef} className="flex w-max items-center gap-2">
                        {children}
                    </div>
                </div>
                {edges.start && <StepButton side="start" onClick={() => step(-1)} />}
                {edges.end && <StepButton side="end" onClick={() => step(1)} />}
            </div>
        </div>
    );
}

function StepButton({ side, onClick }: { side: 'start' | 'end'; onClick: () => void }) {
    const Icon = side === 'start' ? ChevronLeft : ChevronRight;
    return (
        <Button
            variant="outline"
            size="icon-sm"
            aria-label={side === 'start' ? 'Previous attachments' : 'Next attachments'}
            onClick={onClick}
            className={cn(
                'absolute top-1/2 size-7 -translate-y-1/2 rounded-full dark:bg-background',
                side === 'start' ? 'left-0' : 'right-0',
            )}
        >
            <Icon />
        </Button>
    );
}

function edgeMask(start: boolean, end: boolean): string | undefined {
    if (!start && !end) return undefined;
    const from = start ? `transparent, black ${FADE}` : 'black';
    const to = end ? `black calc(100% - ${FADE}), transparent` : 'black';
    return `linear-gradient(to right, ${from}, ${to})`;
}
