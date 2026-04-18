import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { NoteCard } from '@workspace/ui';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { CardDialog } from './card-dialog';
import type { CardItem } from './types';

type CardProps = {
    card: CardItem;
    canWrite?: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
    onContextMenu?: (e: React.MouseEvent, card: CardItem) => void;
    autoOpen?: boolean;
};

export function StickyCard({ card, canWrite = true, yjsDoc, ownerId, mountId, onContextMenu, autoOpen }: CardProps) {
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const autoOpened = useRef(false);

    useEffect(() => {
        if (autoOpen && !autoOpened.current) {
            autoOpened.current = true;
            setIsDialogOpen(true);
        }
    }, [autoOpen]);

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        data: { type: 'task', task: card },
        disabled: !canWrite,
    });

    const wasDragged = useRef(false);

    useEffect(() => {
        if (isDragging) wasDragged.current = true;
    }, [isDragging]);

    const handleClick = (e: React.MouseEvent) => {
        if (wasDragged.current) {
            wasDragged.current = false;
            return;
        }
        e.stopPropagation();
        setIsDialogOpen(true);
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
                    transform: CSS.Transform.toString(transform) || undefined,
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
