import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { Check, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useCreatedByMeta } from '../comments/comment-dialog-meta';
import { CommentThread } from '../comments/comment-thread';
import { NoteCardDialog } from '../notes/note-card-dialog';
import { CardFormDialog } from './card-form-dialog';

type CardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    card: CommentCard | null;
    entry?: CommentEntry;
    ownerId: string;
    mountId: string;
    canWrite?: boolean;
    copyLinkUrl?: string;
    showResolveAction?: boolean;
    onUpdate?: (patch: { title?: string; description?: string; color?: string }) => void;
    onResolve?: (chatName: string, next: 'open' | 'resolved') => void;
};

export function CardDialog({
    open,
    onOpenChange,
    card,
    entry,
    ownerId,
    mountId,
    canWrite = true,
    copyLinkUrl,
    showResolveAction = false,
    onUpdate,
    onResolve,
}: CardDialogProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const meta = useCreatedByMeta(card?.creator, card?.createdAt ?? 0);

    if (!card) return null;

    const action =
        showResolveAction && entry && onResolve
            ? {
                  actionIcon: entry.status === 'open' ? Check : RotateCcw,
                  actionTooltip: entry.status === 'open' ? 'Resolve' : 'Re-open',
                  onAction: () => onResolve(entry.chatName, entry.status === 'open' ? 'resolved' : 'open'),
              }
            : {};

    return (
        <>
            <NoteCardDialog
                open={open}
                onOpenChange={onOpenChange}
                title={card.title}
                description={card.description}
                meta={card.creator ? meta : undefined}
                color={card.color}
                canWrite={canWrite}
                onEdit={onUpdate ? () => setIsSettingsOpen(true) : undefined}
                copyLinkUrl={copyLinkUrl}
                onDescriptionChange={onUpdate ? (html) => onUpdate({ description: html }) : undefined}
                {...action}
            >
                {card.chatName ? (
                    <CommentThread ownerId={ownerId} mountId={mountId} chatName={card.chatName} />
                ) : (
                    <div className="px-4 pb-4 text-sm text-muted-foreground">No chat available for this card.</div>
                )}
            </NoteCardDialog>

            {onUpdate && canWrite && (
                <CardFormDialog
                    key={card.id}
                    open={isSettingsOpen}
                    onOpenChange={setIsSettingsOpen}
                    mode="edit"
                    initialTitle={card.title}
                    initialDescription={card.description}
                    initialColor={card.color ?? EIGEN_STICKIES_COLORS[0][1].value}
                    onSave={onUpdate}
                    dialogTitle="Edit card"
                />
            )}
        </>
    );
}
