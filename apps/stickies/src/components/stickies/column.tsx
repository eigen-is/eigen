import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {StickyCard} from './card';
import {CardItem, ColumnItem} from './types';
import {Pencil, Plus} from 'lucide-react';
import {TooltipButton} from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import * as Y from 'yjs';

type ColumnProps = {
    column: ColumnItem;
    cards: CardItem[];
    isDropAnimating?: boolean;
    onAddCard: (columnId: string) => void;
    onEditColumn: (columnId: string) => void;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
}

export function Column({column, cards, isDropAnimating, onAddCard, onEditColumn, isMobile, yjsDoc, ownerId, mountId}: ColumnProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: column.id,
        data: {type: 'column', column},
    });

    const cardIds = cards.map(c => c.id);
    const columnWidth = isMobile ? 'w-[92vw] min-w-[92vw]' : 'w-[280px] min-w-[280px]';
    const columnMargin = isMobile ? 'mx-[4vw]' : 'mx-1.5';

    return (
        <div
            ref={setNodeRef}
            className={`${columnMargin} ${columnWidth} flex flex-col ${isDragging ? 'opacity-10' : ''} h-full`}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                scrollSnapAlign: 'center',
                scrollSnapStop: 'normal',
            }}
        >
            <div
                className="h-10 pl-3 cursor-grab touch-none font-medium text-sm bg-muted flex-shrink-0 flex items-center justify-between"
                {...attributes}
                {...listeners}
            >
                <span className="truncate flex-1">{column.title}</span>
                <div className="flex items-center">
                    <TooltipButton
                        icon={Plus}
                        tooltipText="Add a sticky"
                        onClick={() => onAddCard(column.id)}
                        className="h-6 w-6 opacity-50 hover:opacity-100 mr-1"
                    />
                    <TooltipButton
                        icon={Pencil}
                        tooltipText="Edit Column"
                        onClick={() => onEditColumn(column.id)}
                        className="h-6 w-6 opacity-50 hover:opacity-100"
                    />
                </div>
            </div>

            <div
                className={`flex-grow overflow-y-auto overflow-x-hidden flex flex-col p-3 border ${
                    isDropAnimating ? 'bg-blue-50/10' : 'bg-background'
                }`}
            >
                {cards.length === 0 ? (
                    <div
                        className="flex-grow min-h-[150px] flex items-center justify-center"
                        data-column-id={column.id}
                    />
                ) : (
                    <div className="flex-grow">
                        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
                            {cards.map((card) => (
                                <StickyCard
                                    key={card.id}
                                    card={card}
                                    isMobile={isMobile}
                                    yjsDoc={yjsDoc}
                                    ownerId={ownerId}
                                    mountId={mountId}
                                />
                            ))}
                        </SortableContext>
                    </div>
                )}

                <button
                    onClick={() => onAddCard(column.id)}
                    className="mt-2 flex items-center gap-1 text-sm text-gray-600 hover:bg-gray-100 px-2 py-1.5 rounded-sm w-full"
                >
                    <Plus size={16}/>
                    <span>Add a sticky</span>
                </button>
            </div>
        </div>
    );
}
