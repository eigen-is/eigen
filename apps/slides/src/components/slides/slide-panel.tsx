// The slide rail: one FrameThumbnail per frame, in stored order, reordered by a drag that rewrites a
// single fractional index. A phone gets SlideStrip instead: the same thumbnails in one row under the
// deck, which only jumps to a slide, since a phone never edits a deck.

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getBackgroundStyle } from '@workspace/lib/background';
import { useMediaResolver } from '@workspace/lib/drive';
import type { VectorElement, VectorFrame } from '@workspace/lib/vector';
import { parseBackgroundFill } from '@workspace/lib/vector';
import type { useContextMenu } from '@workspace/ui/components/context-menu';
import { FrameThumbnail } from '@workspace/ui/components/vector';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { useMemo } from 'react';

// A stable empty list, so a slide with no elements does not hand the thumbnail's memo a fresh array.
const EMPTY_ELEMENTS: VectorElement[] = [];
const noop = () => {};

// A swipe on the deck can page past the strip's visible part. A ref only the current slide's row holds
// runs each time another row becomes current, so the strip follows the deck.
const scrollIntoStrip = (row: HTMLDivElement | null) => {
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
};

type SlidePanelProps = {
    frames: VectorFrame[];
    // The whole scene's elements. The rail slices them ONCE below and hands each thumbnail its own
    // frame's list — per-thumbnail filtering would be O(slides x elements) on every render, and the
    // thumbnail's memo needs a value that only changes when that slide does.
    elements: VectorElement[];
    activeFrameId: string;
    onSelectFrame: (frameId: string) => void;
    onDragStart: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    dragActiveId: string | null;
    // The editor's slide menu; absent for a read-only viewer, so no trigger arms.
    slideMenu?: ReturnType<typeof useContextMenu<string>>;
    matchedFrameIds?: ReadonlySet<string>;
};

export function SlidePanel({
    frames,
    elements,
    activeFrameId,
    onSelectFrame,
    onDragStart,
    onDragEnd,
    dragActiveId,
    slideMenu,
    matchedFrameIds,
}: SlidePanelProps) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    const { resolveMediaUrl } = useMediaResolver();
    // dragActiveId cancels an armed press the moment a drag starts (the stickies-card mechanism).
    const slideLongPress = useLongPress(slideMenu?.openAt ?? noop, { disabled: !!dragActiveId || !slideMenu });

    const dragged = frames.find((frame) => frame.id === dragActiveId);
    const elementsByFrame = useElementsByFrame(frames, elements);

    return (
        <div className="w-52 flex-shrink-0 border-r bg-muted/30 flex flex-col h-full">
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                >
                    <SortableContext items={frames.map((frame) => frame.id)} strategy={verticalListSortingStrategy}>
                        {frames.map((frame, index) => (
                            <SortableSlide key={frame.id} frameId={frame.id} longPressBind={slideLongPress.bind}>
                                <div
                                    onContextMenu={
                                        slideMenu ? (e) => slideMenu.handleContextMenu(e, frame.id) : undefined
                                    }
                                >
                                    <FrameThumbnail
                                        frame={frame}
                                        elements={elementsByFrame.get(frame.id) ?? EMPTY_ELEMENTS}
                                        index={index}
                                        active={frame.id === activeFrameId}
                                        matched={matchedFrameIds?.has(frame.id)}
                                        onSelect={onSelectFrame}
                                    />
                                </div>
                            </SortableSlide>
                        ))}
                    </SortableContext>
                    <DragOverlay>
                        {dragged ? (
                            <div
                                className="w-36 rounded border border-primary overflow-hidden shadow-lg"
                                style={{
                                    aspectRatio: `${dragged.width}/${dragged.height}`,
                                    ...getBackgroundStyle(parseBackgroundFill(dragged.background), resolveMediaUrl),
                                }}
                            />
                        ) : null}
                    </DragOverlay>
                </DndContext>
            </div>
        </div>
    );
}

type SlideStripProps = {
    frames: VectorFrame[];
    elements: VectorElement[];
    activeFrameId: string;
    onSelectFrame: (frameId: string) => void;
    matchedFrameIds?: ReadonlySet<string>;
};

export function SlideStrip({ frames, elements, activeFrameId, onSelectFrame, matchedFrameIds }: SlideStripProps) {
    const elementsByFrame = useElementsByFrame(frames, elements);

    return (
        <div className="flex-shrink-0 overflow-x-auto border-t bg-muted/30">
            <div className="flex gap-1 p-2">
                {frames.map((frame, index) => (
                    <div
                        key={frame.id}
                        ref={frame.id === activeFrameId ? scrollIntoStrip : undefined}
                        className="w-32 flex-shrink-0"
                    >
                        <FrameThumbnail
                            frame={frame}
                            elements={elementsByFrame.get(frame.id) ?? EMPTY_ELEMENTS}
                            index={index}
                            active={frame.id === activeFrameId}
                            matched={matchedFrameIds?.has(frame.id)}
                            onSelect={onSelectFrame}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}

// One pass over the scene per render, not one per slide. An element homed to a frame that is gone
// never appears (the reader re-homes it on read, so this is only a within-tick concern).
function useElementsByFrame(frames: VectorFrame[], elements: VectorElement[]) {
    return useMemo(() => {
        const byFrame = new Map<string, VectorElement[]>();
        for (const frame of frames) byFrame.set(frame.id, []);
        for (const element of elements) byFrame.get(element.frameId)?.push(element);
        return byFrame;
    }, [frames, elements]);
}

function SortableSlide({
    frameId,
    children,
    longPressBind,
}: {
    frameId: string;
    children: React.ReactNode;
    longPressBind: ReturnType<typeof useLongPress<string>>['bind'];
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: frameId });

    // Compose the long-press hook's onPointerDown with dnd-kit's drag-activation listener so a
    // coarse-pointer press opens the menu without clobbering either side. The hook arms only for
    // touch, so mouse drag stays byte-identical.
    const bound = longPressBind(frameId);
    const handlePointerDown = (e: React.PointerEvent) => {
        listeners?.onPointerDown?.(e);
        bound.onPointerDown(e);
    };

    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }}
            {...attributes}
            onPointerDown={handlePointerDown}
            onPointerMove={bound.onPointerMove}
            onPointerUp={bound.onPointerUp}
            onPointerCancel={bound.onPointerCancel}
            onClickCapture={bound.onClickCapture}
        >
            {children}
        </div>
    );
}
