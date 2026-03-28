import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import { Copy, Trash2 } from 'lucide-react';
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
}: SlidePanelProps) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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
                onClick={() => onSelectSlide(slideId)}
            />
        );

        if (mobile) return <div key={slideId}>{thumbnail}</div>;

        return (
            <SortableSlide key={slideId} slideId={slideId} isDragOverlay={false}>
                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <div>{thumbnail}</div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onClick={() => onDuplicateSlide?.(slideId)}>
                            <Copy className="h-4 w-4 mr-2" /> Duplicate
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            variant="destructive"
                            disabled={deck.slideOrder.length <= 1}
                            onClick={() => onDeleteSlide?.(slideId)}
                        >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            </SortableSlide>
        );
    });

    return (
        <div className={`${mobile ? 'w-full' : 'w-52 flex-shrink-0 border-r'} bg-muted/30 flex flex-col h-full`}>
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
                                        backgroundColor: deck.slides[dragActiveId].backgroundColor,
                                    }}
                                />
                            ) : null}
                        </DragOverlay>
                    </DndContext>
                )}
            </div>
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
