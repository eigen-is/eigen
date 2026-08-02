import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getBackgroundStyle } from '@workspace/lib/background';
import { useMediaResolver } from '@workspace/lib/drive';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { Copy, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { SlideThumbnail } from './slide-thumbnail';
import { type DeckData, SLIDE_ASPECT_RATIO } from './types';

type SlidePanelProps = {
    deck: DeckData;
    activeSlideId: string | null;
    onSelectSlide: (slideId: string) => void;
    onDragStart: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    dragActiveId: string | null;
    onDeleteSlide?: (slideId: string) => void;
    onDuplicateSlide?: (slideId: string) => void;
    mobile?: boolean;
    highlightedSlideIds?: ReadonlySet<string>;
};

export function SlidePanel({
    deck,
    activeSlideId,
    onSelectSlide,
    onDragStart,
    onDragEnd,
    dragActiveId,
    onDeleteSlide,
    onDuplicateSlide,
    mobile,
    highlightedSlideIds,
}: SlidePanelProps) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    const { resolveMediaUrl } = useMediaResolver();
    const slideContextMenu = useContextMenu<string>();

    // Mobile thumbnails render bare (no SortableSlide, no per-item component to hang a hook on), so
    // one panel-level useLongPress carries the pressed slide via bind(slideId). This is the only touch
    // path to the menu on mobile — the desktop panel keeps its onContextMenu right-click.
    const { openAt: openSlideMenuAt } = slideContextMenu;
    const handleSlideLongPress = useCallback(
        (slideId: string, x: number, y: number) => {
            openSlideMenuAt(slideId, x, y);
        },
        [openSlideMenuAt],
    );
    const slideLongPress = useLongPress(handleSlideLongPress);

    const slideList = deck.slideOrder.map((slideId, index) => {
        const slide = deck.slides[slideId];
        if (!slide) return null;
        const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);

        const thumbnail = (
            <SlideThumbnail
                slide={slide}
                objects={objects}
                index={index}
                isActive={slideId === activeSlideId}
                matched={highlightedSlideIds?.has(slideId)}
                onClick={() => onSelectSlide(slideId)}
            />
        );

        if (mobile)
            return (
                <div
                    key={slideId}
                    onContextMenu={(e) => slideContextMenu.handleContextMenu(e, slideId)}
                    {...slideLongPress.bind(slideId)}
                >
                    {thumbnail}
                </div>
            );

        return (
            <SortableSlide key={slideId} slideId={slideId} isDragOverlay={false}>
                <div onContextMenu={(e) => slideContextMenu.handleContextMenu(e, slideId)}>{thumbnail}</div>
            </SortableSlide>
        );
    });

    const menuSlideId = slideContextMenu.item;

    return (
        <div className={cn(mobile ? 'w-full' : 'w-52 flex-shrink-0 border-r', 'bg-muted/30 flex flex-col h-full')}>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {mobile ? (
                    slideList
                ) : (
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                    >
                        <SortableContext items={deck.slideOrder} strategy={verticalListSortingStrategy}>
                            {slideList}
                        </SortableContext>
                        <DragOverlay>
                            {dragActiveId && deck.slides[dragActiveId] ? (
                                <div
                                    className="w-36 rounded border border-primary overflow-hidden shadow-lg"
                                    style={{
                                        aspectRatio: SLIDE_ASPECT_RATIO,
                                        ...getBackgroundStyle(deck.slides[dragActiveId].background, resolveMediaUrl),
                                    }}
                                />
                            ) : null}
                        </DragOverlay>
                    </DndContext>
                )}
            </div>
            {/* Rendered on mobile too — long-press is the only way to reach it there. */}
            <ContextMenuAnchor contextMenu={slideContextMenu}>
                {menuSlideId && (
                    <>
                        <DropdownMenuItem onClick={() => onDuplicateSlide?.(menuSlideId)}>
                            <Copy className="h-4 w-4 mr-2" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            disabled={deck.slideOrder.length <= 1}
                            onClick={() => onDeleteSlide?.(menuSlideId)}
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
    slideId,
    children,
    isDragOverlay,
}: {
    slideId: string;
    children: React.ReactNode;
    isDragOverlay: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slideId });

    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging && !isDragOverlay ? 0.3 : 1,
            }}
            {...attributes}
            {...listeners}
        >
            {children}
        </div>
    );
}
