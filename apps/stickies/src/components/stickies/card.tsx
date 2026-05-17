import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { NoteCard } from '@workspace/ui';
import { useRef } from 'react';
import type { CardItem } from './types';

type CardProps = {
    card: CardItem;
    canWrite?: boolean;
    onOpen?: (cardId: string) => void;
    onContextMenu?: (e: React.MouseEvent, card: CardItem) => void;
};

export function StickyCard({ card, canWrite = true, onOpen, onContextMenu }: CardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        data: { type: 'task', task: card },
        disabled: !canWrite,
    });

    const pointerStart = useRef<{ x: number; y: number } | null>(null);

    const handleClick = (e: React.MouseEvent) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (dx * dx + dy * dy > 25) return;
        e.stopPropagation();
        onOpen?.(card.id);
    };

    return (
        <NoteCard
            ref={setNodeRef}
            title={card.title}
            description={card.description}
            color={card.color}
            replyCount={card.messageCount || undefined}
            replyLabel={card.messageCount === 1 ? 'message' : 'messages'}
            onPointerDownCapture={(e: React.PointerEvent) => {
                pointerStart.current = { x: e.clientX, y: e.clientY };
            }}
            onClick={handleClick}
            onContextMenu={onContextMenu ? (e) => onContextMenu(e, card) : undefined}
            className={`mb-2 min-h-20 ${canWrite ? 'cursor-grab touch-none' : 'cursor-pointer'} ${isDragging ? 'opacity-50' : ''}`}
            style={{
                transform: CSS.Transform.toString(transform) || undefined,
                transition,
                zIndex: isDragging ? 10 : 0,
            }}
            {...(canWrite ? { ...attributes, ...listeners } : {})}
        />
    );
}
