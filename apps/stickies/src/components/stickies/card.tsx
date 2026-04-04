import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { NoteCard } from '@workspace/ui';
import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { CardDialog } from './card-dialog';
import type { CardItem } from './types';

function hashRotation(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return ((hash & 0x7fffffff) % 1000) / 1000 - 0.5;
}

type CardProps = {
    card: CardItem;
    canWrite?: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
    onContextMenu?: (e: React.MouseEvent, card: CardItem) => void;
};

export function StickyCard({ card, canWrite = true, yjsDoc, ownerId, mountId, onContextMenu }: CardProps) {
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        data: { type: 'task', task: card },
        disabled: !canWrite,
    });

    const rotation = useMemo(() => hashRotation(card.id), [card.id]);

    const handleClick = (e: React.MouseEvent) => {
        if (!isDragging) {
            e.stopPropagation();
            setIsDialogOpen(true);
        }
    };

    return (
        <>
            <NoteCard
                ref={setNodeRef}
                title={card.title}
                description={card.description}
                color={card.color}
                replyCount={card.messageCount || undefined}
                replyLabel={card.messageCount === 1 ? 'message' : 'messages'}
                onClick={handleClick}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, card) : undefined}
                className={`mb-2 ${canWrite ? 'cursor-grab touch-none' : 'cursor-pointer'} ${isDragging ? 'opacity-50' : ''}`}
                style={{
                    transform: [CSS.Transform.toString(transform), isDragging ? '' : `rotate(${rotation}deg)`]
                        .filter(Boolean)
                        .join(' '),
                    transition,
                    zIndex: isDragging ? 10 : 0,
                }}
                {...(canWrite ? { ...attributes, ...listeners } : {})}
            />

            <CardDialog
                isOpen={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                card={card}
                canWrite={canWrite}
                yjsDoc={yjsDoc}
                ownerId={ownerId}
                mountId={mountId}
            />
        </>
    );
}
