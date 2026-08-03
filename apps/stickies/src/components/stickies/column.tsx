import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { cn } from '@workspace/ui/lib/utils';
import { Pencil, Plus } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { SortableNoteCard } from './sortable-note-card';
import type { ColumnItem } from './types';

type ColumnProps = {
    column: ColumnItem;
    cards: CommentCard[];
    entryByChatName: Map<string, CommentEntry>;
    canWrite?: boolean;
    onAddCard: (columnId: string) => void;
    onEditColumn: (columnId: string) => void;
    onCardOpen?: (cardId: string) => void;
    onCardContextMenu?: (e: React.MouseEvent, card: CommentCard) => void;
    onCardLongPress?: (card: CommentCard, x: number, y: number) => void;
    isMobile: boolean;
    scrollToTopSignal?: number;
    highlighted?: boolean;
    highlightedCardIds?: ReadonlySet<string>;
};

export const Column = memo(function Column({
    column,
    cards,
    entryByChatName,
    canWrite = true,
    onAddCard,
    onEditColumn,
    onCardOpen,
    onCardContextMenu,
    onCardLongPress,
    isMobile,
    scrollToTopSignal,
    highlighted,
    highlightedCardIds,
}: ColumnProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: column.id,
        data: { type: 'column', column },
        disabled: !canWrite,
    });
    const contentRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (scrollToTopSignal === undefined) return;
        contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, [scrollToTopSignal]);

    // Stable array identity — dnd-kit's SortableContext keys its context value on it, and a fresh
    // array per render would re-render every useSortable card regardless of React.memo.
    const cardIds = useMemo(() => cards.map((c) => c.id), [cards]);
    const columnWidth = isMobile ? 'w-[92vw] min-w-[92vw]' : 'w-[280px] min-w-[280px]';
    const columnMargin = isMobile ? 'mx-[4vw]' : 'mx-1.5';

    return (
        <div
            ref={setNodeRef}
            data-search-anchor={`column:${column.id}`}
            className={cn(columnMargin, columnWidth, 'flex flex-col h-full', isDragging && 'opacity-10')}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                scrollSnapAlign: 'center',
                scrollSnapStop: 'normal',
            }}
        >
            <div
                className={cn(
                    'h-10 pl-3 font-medium text-sm bg-muted flex-shrink-0 flex items-center justify-between',
                    canWrite && 'cursor-grab touch-none',
                    highlighted && 'eigen-search-ring',
                )}
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
                ref={contentRef}
                className="flex-grow overflow-y-auto overflow-x-hidden flex flex-col p-3 rounded-lg bg-background"
            >
                {cards.length === 0 ? (
                    <div
                        className="flex-grow min-h-[150px] flex items-center justify-center"
                        data-column-id={column.id}
                    />
                ) : (
                    <div className="flex-grow space-y-2">
                        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
                            {cards.map((card) => {
                                const entry = card.chatName ? entryByChatName.get(card.chatName) : undefined;
                                return (
                                    <SortableNoteCard
                                        key={card.id}
                                        card={card}
                                        replyCount={entry?.messageCount}
                                        resolved={entry?.status === 'resolved'}
                                        assigneeEmail={entry?.assignee}
                                        canWrite={canWrite}
                                        highlighted={highlightedCardIds?.has(card.id)}
                                        onOpen={onCardOpen}
                                        onContextMenu={onCardContextMenu}
                                        onLongPress={onCardLongPress}
                                    />
                                );
                            })}
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
});
