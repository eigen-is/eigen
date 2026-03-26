import {useMemo, useState} from 'react';
import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {CardItem} from './types';
import {CardDialog} from './card-dialog';
import {Card, CardContent} from '@workspace/ui/components/card';
import {isLightColor} from '@workspace/ui/components/layout/media/color-picker';
import {lightenColor} from '@workspace/lib/constants';
import * as Y from 'yjs';

function hashRotation(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return (((hash & 0x7fffffff) % 1000) / 1000 - 0.5); // range: -0.5 to 0.5 degrees
}

type CardProps = {
    card: CardItem;
    canWrite?: boolean;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
    onContextMenu?: (e: React.MouseEvent, card: CardItem) => void;
}

export function StickyCard({card, canWrite = true, isMobile, yjsDoc, ownerId, mountId, onContextMenu}: CardProps) {
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: card.id,
        data: {type: 'task', task: card},
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
            <Card
                ref={setNodeRef}
                className={`mb-2 p-0 w-full shadow-md select-none rounded-none ${!card.color ? 'border' : 'border-0'} ${canWrite ? 'cursor-grab touch-none' : 'cursor-pointer'} ${isDragging ? 'opacity-50' : ''}`}
                style={{
                    transform: [CSS.Transform.toString(transform), isDragging ? '' : `rotate(${rotation}deg)`].filter(Boolean).join(' '),
                    transition,
                    zIndex: isDragging ? 10 : 0,
                    backgroundColor: card.color ? lightenColor(card.color, 0.25) : undefined,
                    color: card.color ? (isLightColor(card.color) ? '#000' : '#fff') : undefined,
                }}
                {...(canWrite ? {...attributes, ...listeners} : {})}
                onClick={handleClick}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, card) : undefined}
            >
                <CardContent className={`p-3 text-sm ${isDragging && !card.color ? 'bg-accent' : ''}`}>
                    {card.title}
                    {card.description && (
                        <p className="text-xs mt-1 line-clamp-2" style={{opacity: 0.7}}>{card.description}</p>
                    )}
                </CardContent>
            </Card>

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
