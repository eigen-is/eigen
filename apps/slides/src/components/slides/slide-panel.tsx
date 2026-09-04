// The slide rail: one FrameThumbnail per frame, in stored order, reordered by a drag that rewrites a
// single fractional index. Desktop-only — a phone pages the deck with a swipe (spec D8).

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getBackgroundStyle } from '@workspace/lib/background';
import { useMediaResolver } from '@workspace/lib/drive';
import { FRAME_ASPECT_RATIO, parseBackgroundFill, type VectorElement, type VectorFrame } from '@workspace/lib/vector';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { FrameThumbnail } from '@workspace/ui/components/vector';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { Copy, Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';

// A stable empty list, so a slide with no elements does not hand the thumbnail's memo a fresh array.
const EMPTY_ELEMENTS: VectorElement[] = [];

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
    onDeleteSlide?: (frameId: string) => void;
    onDuplicateSlide?: (frameId: string) => void;
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
    onDeleteSlide,
    onDuplicateSlide,
    matchedFrameIds,
}: SlidePanelProps) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    const { resolveMediaUrl } = useMediaResolver();
    const slideContextMenu = useContextMenu<string>();

    // Read-only viewers get no handlers, so the menu would open empty — don't arm its triggers.
    const hasSlideActions = !!onDuplicateSlide || !!onDeleteSlide;

    // One instance at panel level: bind(frameId) is what carries the pressed slide into the menu.
    const { openAt: openSlideMenuAt } = slideContextMenu;
    const handleSlideLongPress = useCallback(
        (frameId: string, x: number, y: number) => openSlideMenuAt(frameId, x, y),
        [openSlideMenuAt],
    );
    // dragActiveId cancels an armed press the moment a drag starts (the stickies-card mechanism).
    const slideLongPress = useLongPress(handleSlideLongPress, { disabled: !!dragActiveId || !hasSlideActions });

    const menuFrameId = slideContextMenu.item;
    const dragged = frames.find((frame) => frame.id === dragActiveId);

    // One pass over the scene per render, not one per slide. An element homed to a frame that is gone
    // never appears (the reader re-homes it on read, so this is only a within-tick concern).
    const elementsByFrame = useMemo(() => {
        const byFrame = new Map<string, VectorElement[]>();
        for (const frame of frames) byFrame.set(frame.id, []);
        for (const element of elements) byFrame.get(element.frameId)?.push(element);
        return byFrame;
    }, [frames, elements]);

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
                                        hasSlideActions
                                            ? (e) => slideContextMenu.handleContextMenu(e, frame.id)
                                            : undefined
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
                                    aspectRatio: FRAME_ASPECT_RATIO,
                                    ...getBackgroundStyle(parseBackgroundFill(dragged.background), resolveMediaUrl),
                                }}
                            />
                        ) : null}
                    </DragOverlay>
                </DndContext>
            </div>
            <ContextMenuAnchor contextMenu={slideContextMenu}>
                {menuFrameId && (
                    <>
                        <DropdownMenuItem onClick={() => onDuplicateSlide?.(menuFrameId)}>
                            <Copy className="h-4 w-4 mr-2" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            disabled={frames.length <= 1}
                            onClick={() => onDeleteSlide?.(menuFrameId)}
                        >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </DropdownMenuItem>
                    </>
                )}
            </ContextMenuAnchor>
        </div>
    );
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
