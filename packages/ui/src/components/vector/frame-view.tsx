// One frame as a read-only page: its background and its elements, laid out at the frame's own 1920 px width and
// shrunk as a whole to the box the host gives it, as the server's compositor does. Hosts such as present mode and the
// Slides rail draw a slide through it, so a slide looks the same in each. It draws through ElementLayer, the component
// the live canvas uses, so it can't drift from the editor either. FrameThumbnail is the rail's tile.

import { getBackgroundStyle } from '@workspace/lib/background';
import { useMediaResolver } from '@workspace/lib/drive';
import type { MediaResolver, VectorElement, VectorFrame } from '@workspace/lib/vector';
import { elementsInFrame, orderByFractionalIndex, parseBackgroundFill } from '@workspace/lib/vector';
import { useElementSize } from '@workspace/ui/hooks/use-element-size';
import { cn } from '@workspace/ui/lib/utils';
import { memo, useId, useMemo, useRef } from 'react';
import { ElementLayer } from './element-layer';
import { CANVAS_PAPER_CLASS } from './paper';

type FrameViewProps = {
    frame: VectorFrame;
    // The whole scene's elements, or only this frame's. Present mode passes the whole scene, so an elbow arrow still
    // routes around a shape bound outside its frame. The rail passes the frame's own, so a tile's memo has a stable
    // list to compare. The view keeps to its frame either way.
    elements: readonly VectorElement[];
    resolveMedia?: MediaResolver;
    // Lets pointer events reach the layers, for working links in present mode. A tile in the rail takes none.
    interactive?: boolean;
    className?: string;
};

export function FrameView({ frame, elements, resolveMedia, interactive, className }: FrameViewProps) {
    const [setContainer, { width }] = useElementSize<HTMLDivElement>();
    // The scale is 0 until the box is measured, and nothing is drawn before that. A box of 0 by 0 is never reported,
    // but one 0 wide is, such as a rail column collapsed behind a closed panel. Then the last real scale stays, so the
    // page doesn't go blank.
    const lastScale = useRef(0);
    if (width > 0) lastScale.current = width / frame.width;
    const scale = lastScale.current;
    // The rail and present mode draw the canvas's elements again on its page.
    const idScope = useId();

    const own = useMemo(() => orderByFractionalIndex(elementsInFrame(elements, frame.id)), [elements, frame.id]);
    const byId = useMemo(() => new Map(elements.map((el) => [el.id, el])), [elements]);

    return (
        <div
            ref={setContainer}
            // The page is light, as on the live canvas, so the colors of what is on it resolve against the light
            // palette, in dark mode too.
            className={cn(
                CANVAS_PAPER_CLASS,
                'relative overflow-hidden',
                !interactive && 'pointer-events-none',
                className,
            )}
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
                    own.map((el) => (
                        <ElementLayer key={el.id} el={el} resolveMedia={resolveMedia} byId={byId} idScope={idScope} />
                    ))}
            </div>
        </div>
    );
}

type FrameThumbnailProps = {
    frame: VectorFrame;
    elements: readonly VectorElement[];
    index: number;
    active: boolean;
    matched?: boolean;
    // It takes the frame's id rather than closing over it. So the rail hands every tile the same handler, and a new
    // closure on each render doesn't defeat the memo.
    onSelect: (frameId: string) => void;
};

// The memo of a tile in the rail. It compares the frame's stored fields and its own elements, which the host hands
// over as a slice, so a long deck doesn't filter the whole scene for every tile. A pan, a hover, a selection or an edit
// on another slide then renders no tile again. A Yjs update builds new element objects, so a new object means this
// slide may have changed. ElementLayer then compares the fields of each element and skips the ones that didn't.
export function sameThumbnail(prev: FrameThumbnailProps, next: FrameThumbnailProps): boolean {
    if (prev.index !== next.index || prev.active !== next.active || prev.matched !== next.matched) return false;
    if (prev.onSelect !== next.onSelect) return false;
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
    onSelect,
}: FrameThumbnailProps) {
    // A tile draws each picture from its still thumbnail, so the rail doesn't play every GIF in the deck at once.
    const { resolveMediaThumbnailUrl } = useMediaResolver();

    return (
        // No text selection and no callout, so a long press doesn't open the iOS loupe, as on .eigen-list-item.
        <button
            type="button"
            aria-current={active || undefined}
            onClick={() => onSelect(frame.id)}
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
                resolveMedia={resolveMediaThumbnailUrl}
                className={cn(
                    'min-w-0 flex-1 rounded border',
                    active ? 'border-selection-handle shadow-sm' : 'border-border',
                    matched && 'eigen-search-ring',
                )}
            />
        </button>
    );
}, sameThumbnail);
