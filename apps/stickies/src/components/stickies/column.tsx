import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { Pencil, Plus } from 'lucide-react';
import type * as Y from 'yjs';
import { StickyCard } from './card';
import type { CardItem, ColumnItem } from './types';

type ColumnProps = {
    column: ColumnItem;
    cards: CardItem[];
    canWrite?: boolean;
    isDropAnimating?: boolean;
    onAddCard: (columnId: string) => void;
    onEditColumn: (columnId: string) => void;
    onCardContextMenu?: (e: React.MouseEvent, card: CardItem) => void;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
};

export function Column({
    column,
    cards,
    canWrite = true,
    isDropAnimating,
    onAddCard,
    onEditColumn,
    onCardContextMenu,
    isMobile,
    yjsDoc,
    ownerId,
    mountId,
}: ColumnProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: column.id,
        data: { type: 'column', column },
        disabled: !canWrite,
    });

    const cardIds = cards.map((c) => c.id);
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
                className={`h-10 pl-3 font-medium text-sm bg-muted flex-shrink-0 flex items-center justify-between ${canWrite ? 'cursor-grab touch-none' : ''}`}
                {...(canWrite ? { ...attributes, ...listeners } : {})}
            >
                <span className="truncate flex-1">{column.title}</span>
                {canWrite && (
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
                )}
            </div>

            <div
                className={`flex-grow overflow-y-auto overflow-x-hidden flex flex-col p-3 border ${
                    isDropAnimating ? 'bg-accent/10' : 'bg-background'
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
                                    canWrite={canWrite}
                                    isMobile={isMobile}
                                    yjsDoc={yjsDoc}
                                    ownerId={ownerId}
                                    mountId={mountId}
                                    onContextMenu={onCardContextMenu}
                                />
                            ))}
                        </SortableContext>
                    </div>
                )}

                {canWrite && (
                    <button
                        onClick={() => onAddCard(column.id)}
                        className="mt-2 flex items-center gap-1 text-sm text-muted-foreground hover:bg-muted px-2 py-1.5 rounded-sm w-full"
                    >
                        <Plus size={16} />
                        <span>Add a sticky</span>
                    </button>
                )}
            </div>
        </div>
    );
}
