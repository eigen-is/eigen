import {useState} from 'react';
import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {CardItem} from './types';
import {CardDialog} from './card-dialog';
import {Card, CardContent} from '@workspace/ui/components/card';
import * as Y from 'yjs';

type CardProps = {
    card: CardItem;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
}

export function StickyCard({card, isMobile, yjsDoc, ownerId, mountId}: CardProps) {
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
    });

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
                className={`mb-2 p-0 w-full select-none cursor-grab touch-none ${isDragging ? 'opacity-50' : ''}`}
                style={{
                    transform: CSS.Transform.toString(transform),
                    transition,
                    zIndex: isDragging ? 10 : 0,
                    backgroundColor: card.color || undefined,
                }}
                {...attributes}
                {...listeners}
                onClick={handleClick}
            >
                <CardContent className={`p-3 text-sm ${isDragging ? 'bg-blue-50' : ''}`}>
                    {card.title}
                    {card.description && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">{card.description}</p>
                    )}
                </CardContent>
            </Card>

            <CardDialog
                isOpen={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                card={card}
                yjsDoc={yjsDoc}
                ownerId={ownerId}
                mountId={mountId}
            />
        </>
    );
}
