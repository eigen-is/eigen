// One frame as a read-only page: its own background and its own elements, laid out at the frame's
// 1920x1080 scale and shrunk as a whole to whatever box the host gives it. The rail thumbnail and
// present mode both render this, so a slide cannot look different in the two places — and both draw
// through ElementLayer, the same component the live canvas uses, so neither can drift from the editor.
// Scaling the page rather than re-unitising its contents is the server compositor's model too
// (export/canvas/render.ts): a layer body is authored in scene pixels by packages/lib.

import { getBackgroundStyle } from '@workspace/lib/background';
import { useMediaResolver } from '@workspace/lib/drive';
import {
    elementsInFrame,
    type MediaResolver,
    orderByFractionalIndex,
    parseBackgroundFill,
    type VectorElement,
    type VectorFrame,
} from '@workspace/lib/vector';
import { cn } from '@workspace/ui/lib/utils';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ElementLayer } from './element-layer';

type FrameViewProps = {
    frame: VectorFrame;
    // Either the whole scene's elements (present mode passes those, so an elbow arrow still routes
    // against a shape bound outside its frame) or just this frame's slice (the rail passes that, so a
    // thumbnail's memo has something stable to compare). The view scopes to the frame either way.
    elements: VectorElement[];
    resolveMedia?: MediaResolver;
    // Let pointer events reach the layers — present mode wants working links; a thumbnail does not.
    interactive?: boolean;
    className?: string;
};

export function FrameView({ frame, elements, resolveMedia, interactive, className }: FrameViewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    // 0 until measured: the page is drawn at frame scale and shrunk, so there is nothing to draw yet.
    const [scale, setScale] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            const width = el.clientWidth;
            if (width > 0) setScale(width / frame.width);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        measure();
        return () => observer.disconnect();
    }, [frame.width]);

    const own = useMemo(() => orderByFractionalIndex(elementsInFrame(elements, frame.id)), [elements, frame.id]);
    const byId = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);

    return (
        <div
            ref={containerRef}
            className={cn('relative overflow-hidden', !interactive && 'pointer-events-none', className)}
            style={{
                aspectRatio: `${frame.width}/${frame.height}`,
                ...getBackgroundStyle(parseBackgroundFill(frame.background), resolveMedia),
            }}
        >
            <div
                className="absolute top-0 left-0 origin-top-left"
                style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}
            >
                {scale > 0 &&
                    own.map((el) => <ElementLayer key={el.id} el={el} resolveMedia={resolveMedia} byId={byId} />)}
            </div>
        </div>
    );
}

type FrameThumbnailProps = {
    frame: VectorFrame;
    elements: VectorElement[];
    index: number;
    active: boolean;
    matched?: boolean;
    onClick: () => void;
};

// The rail row. The memo compares the frame's OWN elements (the host passes the slice, so a 60-slide
// deck does not re-filter the whole scene per thumbnail per render) plus the frame's stored fields:
// a pan, a hover, a selection change or an edit on another slide re-renders nothing here. A Yjs tick
// re-materialises the elements, so identity is the honest signal that this slide may have changed;
// the per-element work is then skipped again by ElementLayer's own field compare.
export function sameThumbnail(prev: FrameThumbnailProps, next: FrameThumbnailProps): boolean {
    if (prev.index !== next.index || prev.active !== next.active || prev.matched !== next.matched) return false;
    if (prev.onClick !== next.onClick) return false;
    if (prev.frame.id !== next.frame.id || prev.frame.background !== next.frame.background) return false;
    if (prev.elements.length !== next.elements.length) return false;
    return prev.elements.every((el, i) => el === next.elements[i]);
}

export const FrameThumbnail = memo(function FrameThumbnail({
    frame,
    elements,
    index,
    active,
    matched,
    onClick,
}: FrameThumbnailProps) {
    const { resolveMediaUrl } = useMediaResolver();

    return (
        // select-none + callout suppression keep a long press off iOS's loupe (as .eigen-list-item does).
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex w-full items-start gap-2 rounded-sm px-1 py-1 text-left',
                'select-none [-webkit-touch-callout:none]',
                active && 'bg-accent',
            )}
        >
            <span className="mt-1 w-4 flex-shrink-0 text-right text-[10px] text-muted-foreground">{index + 1}</span>
            <FrameView
                frame={frame}
                elements={elements}
                resolveMedia={resolveMediaUrl}
                className={cn(
                    'min-w-0 flex-1 rounded border',
                    active ? 'border-selection-handle shadow-sm' : 'border-border',
                    matched && 'eigen-search-ring',
                )}
            />
        </button>
    );
}, sameThumbnail);
