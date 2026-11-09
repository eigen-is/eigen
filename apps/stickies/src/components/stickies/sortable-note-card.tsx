// One card on a Stickies board as a draggable item: the NoteCard with its replies, status, assignee and unread
// dot, wired to dnd-kit so it can be dragged, opened with a click that didn't move, or long-pressed for its menu
// on touch. A peer working on the card outlines it in their color and shows their name.

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CommentCard } from '@workspace/lib/types/comments';
import { useAttachmentMeta } from '@workspace/ui/components/attachment';
import { PresenceLabel } from '@workspace/ui/components/collab';
import { NoteCard } from '@workspace/ui/components/notes';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { cn } from '@workspace/ui/lib/utils';
import { memo, useCallback, useRef } from 'react';
import type { CardPeer } from './hooks/use-stickies-presence';

type SortableNoteCardProps = {
    card: CommentCard;
    replyCount?: number;
    unread: boolean;
    resolved?: boolean;
    assigneeEmail?: string | null;
    canWrite?: boolean;
    highlighted?: boolean;
    // A remote peer working on this card (dialog open or dragging), or undefined.
    peer?: CardPeer;
    onOpen?: (cardId: string) => void;
    onContextMenu?: (e: React.MouseEvent, card: CommentCard) => void;
    onLongPress?: (card: CommentCard, x: number, y: number) => void;
};

export const SortableNoteCard = memo(function SortableNoteCard({
    card,
    replyCount,
    unread,
    resolved,
    assigneeEmail,
    canWrite = true,
    highlighted,
    peer,
    onOpen,
    onContextMenu,
    onLongPress,
}: SortableNoteCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: card.id,
        data: { type: 'task', task: card },
        disabled: !canWrite,
    });
    const { coverThumbnailUrl, attachmentCount } = useAttachmentMeta(card.attachments);

    // Compose dnd-kit's node ref with a stable data-attribute so the search controller can
    // scroll-to + flash this card by its match id (NoteCard's typed props stay clean).
    const setRef = useCallback(
        (node: HTMLDivElement | null) => {
            setNodeRef(node);
            if (node) node.dataset.searchAnchor = `card:${card.id}`;
        },
        [setNodeRef, card.id],
    );

    // The drag sensor's `touch-none` suppresses the native context menu, so touch gets it by long press. A drag
    // starts at 5 px but the press only cancels at 10 px, so `isDragging` disarms it or the menu opens mid-drag.
    const longPress = useLongPress<CommentCard>((c, x, y) => onLongPress?.(c, x, y), {
        disabled: !canWrite || !onLongPress || isDragging,
    });
    const bound = longPress.bind(card);
    const handlePointerDown = (e: React.PointerEvent) => {
        if (canWrite) listeners?.onPointerDown?.(e);
        bound.onPointerDown(e);
    };

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
        // The peer's name sits inside the card's corner, as the column's scroll container would clip it above
        // the top card. The wrapper anchors it, so the drag transform stays on the node dnd-kit measures.
        <div className="relative">
            <NoteCard
                ref={setRef}
                title={card.title}
                description={card.description}
                color={card.color}
                replyCount={replyCount}
                unread={unread}
                resolved={resolved}
                assigneeEmail={assigneeEmail}
                coverThumbnailUrl={coverThumbnailUrl}
                attachmentCount={attachmentCount}
                onPointerDownCapture={(e: React.PointerEvent) => {
                    pointerStart.current = { x: e.clientX, y: e.clientY };
                }}
                onClick={handleClick}
                onClickCapture={bound.onClickCapture}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, card) : undefined}
                onPointerDown={handlePointerDown}
                onPointerMove={bound.onPointerMove}
                onPointerUp={bound.onPointerUp}
                onPointerCancel={bound.onPointerCancel}
                className={cn(
                    canWrite && 'cursor-grab touch-none',
                    isDragging && 'opacity-50',
                    highlighted && 'eigen-search-ring',
                    peer && 'eigen-selection-ring eigen-selection-ring-peer',
                )}
                style={{
                    transform: CSS.Transform.toString(transform) || undefined,
                    transition,
                    zIndex: isDragging ? 10 : 0,
                    ...(peer ? { '--peer-color': peer.color } : undefined),
                }}
                {...(canWrite ? attributes : {})}
            />
            {peer && (
                <div className="pointer-events-none absolute left-1 top-1 z-10">
                    <PresenceLabel color={peer.color} name={peer.name} />
                </div>
            )}
        </div>
    );
});
