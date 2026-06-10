import { useResolveCardAttachments } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { useMediaResolver } from '@workspace/lib/drive';
import type { ChatAttachment, CommentEntry } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CommentCard } from '@workspace/lib/types/comments';
import { Check, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { AttachmentChip } from '../attachment/attachment-chip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { SimpleAttachmentChip } from '../attachment/simple-attachment-chip';
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
    onUpdate?: (patch: {
        title?: string;
        description?: string;
        color?: string;
        attachments?: ChatAttachment[];
    }) => void;
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
    onUpdate,
    onResolve,
}: CardDialogProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const { mediaFolderId } = useMediaResolver();
    const resolveAttachments = useResolveCardAttachments(ownerId, mountId, mediaFolderId);

    const meta = useCreatedByMeta(card?.creator, card?.createdAt ?? 0);

    if (!card) return null;

    const action =
        entry && onResolve
            ? {
                  actionIcon: entry.status === 'open' ? Check : RotateCcw,
                  actionTooltip: entry.status === 'open' ? 'Resolve' : 'Re-open',
                  onAction: () => onResolve(entry.chatName, entry.status === 'open' ? 'resolved' : 'open'),
              }
            : {};

    const attachmentNames = card.attachments?.filter((a): a is string => typeof a === 'string') ?? [];

    const handleEditSave = async (
        patch: { title?: string; description?: string; color?: string },
        drafts?: CardAttachmentDraft[],
    ) => {
        if (!onUpdate) return;
        if (drafts === undefined) {
            onUpdate(patch);
            return;
        }
        const attachments = await resolveAttachments(drafts);
        onUpdate({ ...patch, attachments });
    };

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
                {card.attachments && card.attachments.length > 0 && (
                    <div className="px-4 pb-3 flex flex-wrap gap-2">
                        {card.attachments.map((attachment) =>
                            isAttachmentReference(attachment) ? (
                                <ReferenceAttachmentChip key={`ref-${attachment.id}`} reference={attachment} />
                            ) : mediaFolderId ? (
                                <AttachmentChip
                                    key={`name-${attachment}`}
                                    fileName={attachment}
                                    ownerId={ownerId}
                                    mountId={mountId}
                                    mediaFolderId={mediaFolderId}
                                    siblingFileNames={attachmentNames}
                                />
                            ) : (
                                <SimpleAttachmentChip key={`name-${attachment}`} filename={attachment} />
                            ),
                        )}
                    </div>
                )}
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
                    allowAttachments={!!mediaFolderId}
                    initialAttachments={card.attachments}
                    onSave={handleEditSave}
                    dialogTitle="Edit card"
                />
            )}
        </>
    );
}
