import {DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {SlideThumbnail} from './slide-thumbnail';
import {DeckData, SLIDE_ASPECT_RATIO} from './types';
import type {DragStartEvent, DragEndEvent} from '@dnd-kit/core';

type SlidePanelProps = {
    deck: DeckData;
    activeSlideId: string | null;
    onSelectSlide: (slideId: string) => void;
    onDragStart: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    dragActiveId: string | null;
}

export function SlidePanel({deck, activeSlideId, onSelectSlide, onDragStart, onDragEnd, dragActiveId}: SlidePanelProps) {
    const sensors = useSensors(
        useSensor(PointerSensor, {activationConstraint: {distance: 5}})
    );

    return (
        <div className="w-52 flex-shrink-0 border-r bg-muted/30 flex flex-col h-full">
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                >
                    <SortableContext items={deck.slideOrder} strategy={verticalListSortingStrategy}>
                        {deck.slideOrder.map((slideId, index) => {
                            const slide = deck.slides[slideId];
                            if (!slide) return null;
                            const objects = slide.objectIds
                                .map(id => deck.objects[id])
                                .filter(Boolean);
                            return (
                                <SortableSlide
                                    key={slideId}
                                    slideId={slideId}
                                    isDragOverlay={false}
                                >
                                    <SlideThumbnail
                                        slide={slide}
                                        objects={objects}
                                        index={index}
                                        isActive={slideId === activeSlideId}
                                        onClick={() => onSelectSlide(slideId)}
                                    />
                                </SortableSlide>
                            );
                        })}
                    </SortableContext>

                    <DragOverlay>
                        {dragActiveId && deck.slides[dragActiveId] ? (
                            <div
                                className="w-36 rounded border border-blue-500 overflow-hidden shadow-lg"
                                style={{aspectRatio: SLIDE_ASPECT_RATIO, backgroundColor: deck.slides[dragActiveId].backgroundColor}}
                            />
                        ) : null}
                    </DragOverlay>
                </DndContext>
            </div>
        </div>
    );
}

function SortableSlide({slideId, children, isDragOverlay}: {slideId: string; children: React.ReactNode; isDragOverlay: boolean}) {
    const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: slideId});

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
