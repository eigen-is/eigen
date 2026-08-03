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

    // Read-only viewers get no handlers, so the menu would open empty — don't arm its triggers.
    const hasSlideActions = !!onDuplicateSlide || !!onDeleteSlide;

    // Desktop layout only: SortableSlide composes this in so a coarse-pointer press (iPad) reaches the
    // same menu the mouse gets by right-click. bind(slideId) carries the pressed slide, which is why the
    // instance lives at panel level. Mobile thumbnails are view-only — they bind nothing.
    const { openAt: openSlideMenuAt } = slideContextMenu;
    const handleSlideLongPress = useCallback(
        (slideId: string, x: number, y: number) => {
            openSlideMenuAt(slideId, x, y);
        },
        [openSlideMenuAt],
    );
    // dragActiveId cancels an armed press the moment a drag starts (same mechanism as stickies cards).
    const slideLongPress = useLongPress(handleSlideLongPress, { disabled: !!dragActiveId || !hasSlideActions });

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

        if (mobile) return <div key={slideId}>{thumbnail}</div>;

        const onContextMenu = hasSlideActions
            ? (e: React.MouseEvent) => slideContextMenu.handleContextMenu(e, slideId)
            : undefined;

        return (
            <SortableSlide key={slideId} slideId={slideId} isDragOverlay={false} longPressBind={slideLongPress.bind}>
                <div onContextMenu={onContextMenu}>{thumbnail}</div>
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
            {!mobile && (
                <ContextMenuAnchor contextMenu={slideContextMenu}>
                    {menuSlideId && (
                        <>
                            {onDuplicateSlide && (
                                <DropdownMenuItem onClick={() => onDuplicateSlide(menuSlideId)}>
                                    <Copy className="h-4 w-4 mr-2" /> Duplicate
                                </DropdownMenuItem>
                            )}
                            {onDuplicateSlide && onDeleteSlide && <DropdownMenuSeparator />}
                            {onDeleteSlide && (
                                <DropdownMenuItem
                                    variant="destructive"
                                    disabled={deck.slideOrder.length <= 1}
                                    onClick={() => onDeleteSlide(menuSlideId)}
                                >
                                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                                </DropdownMenuItem>
                            )}
                        </>
                    )}
                </ContextMenuAnchor>
            )}
        </div>
    );
}

function SortableSlide({
    slideId,
    children,
    isDragOverlay,
    longPressBind,
}: {
    slideId: string;
    children: React.ReactNode;
    isDragOverlay: boolean;
    longPressBind: ReturnType<typeof useLongPress<string>>['bind'];
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slideId });

    // Compose the long-press hook's onPointerDown with dnd-kit's drag-activation listener so a
    // coarse-pointer press opens the menu in desktop layout too, without clobbering either side.
    // The hook arms only for touch, so mouse drag stays byte-identical.
    const bound = longPressBind(slideId);
    const handlePointerDown = (e: React.PointerEvent) => {
        listeners?.onPointerDown?.(e);
        bound.onPointerDown(e);
    };

    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                opacity: isDragging && !isDragOverlay ? 0.3 : 1,
            }}
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
