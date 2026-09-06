import { useResolveCardAttachments } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { useMediaResolver } from '@workspace/lib/drive';
import type { ChatAttachment, CommentEntry } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, RotateCcw } from 'lucide-react';
import { AttachmentChip } from '../attachment/attachment-chip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { SimpleAttachmentChip } from '../attachment/simple-attachment-chip';
import { AssigneeChip } from '../comments/assignee-chip';
import { AssigneePicker } from '../comments/assignee-picker';
import { CommentThread } from '../comments/comment-thread';
import { CreatedByMeta } from '../comments/created-by-meta';
import { NoteCardDialog } from '../notes/note-card-dialog';
import { CardForm } from './card-form';

type CardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    card: CommentCard | null;
    entry?: CommentEntry;
    ownerId: string;
    mountId: string;
    canWrite?: boolean;
    // Edit mode is owned by the lifecycle bundle so the menus' Edit row can open straight into it.
    isEditing: boolean;
    onEditingChange: (editing: boolean) => void;
    copyLinkUrl?: string;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onUpdate?: (patch: {
        title?: string;
        description?: string;
        color?: string;
        attachments?: ChatAttachment[];
    }) => void;
    onResolve?: (chatName: string, next: 'open' | 'resolved', title?: string) => void;
    onAssign?: (chatName: string, assignee: string | null, title?: string) => void;
};

export function CardDialog({
    open,
    onOpenChange,
    card,
    entry,
    ownerId,
    mountId,
    canWrite = true,
    isEditing,
    onEditingChange,
    copyLinkUrl,
    members,
    currentUserEmail,
    onUpdate,
    onResolve,
    onAssign,
}: CardDialogProps) {
    const { mediaFolderId } = useMediaResolver();
    const resolveAttachments = useResolveCardAttachments(ownerId, mountId, mediaFolderId);

    if (!card) return null;

    // Missing entry = unseeded legacy thread, open and unassigned (matchesCommentFilter's rule);
    // the first assign/resolve write seeds it server-side.
    const chatName = card.chatName;
    const status = entry?.status ?? 'open';
    const assignee = entry?.assignee ?? null;

    // Resolve/re-open is a write, gated like the menus' row and the Edit pencil: a read-only viewer
    // would only get the 403 the collab route answers with.
    const action =
        canWrite && chatName && onResolve
            ? {
                  actionIcon: status === 'open' ? Check : RotateCcw,
                  actionTooltip: status === 'open' ? 'Resolve' : 'Re-open',
                  onAction: () => onResolve(chatName, status === 'open' ? 'resolved' : 'open', card.title),
              }
            : {};

    const attachmentNames = card.attachments?.filter((a): a is string => typeof a === 'string') ?? [];

    const handleEditSave = async (
        patch: { title?: string; description?: string; color?: string },
        drafts?: CardAttachmentDraft[],
        assignee?: string | null,
    ) => {
        // Same Save may rename the card — use the new title so the activity event + title cache
        // don't record the stale pre-edit name.
        if (assignee !== undefined && card.chatName) onAssign?.(card.chatName, assignee, patch.title ?? card.title);
        if (!onUpdate) return;
        if (drafts === undefined) {
            onUpdate(patch);
            return;
        }
        const attachments = await resolveAttachments(drafts);
        onUpdate({ ...patch, attachments });
    };

    // The assignee sits in the dialog's meta row: an inline picker when reassignable, else an inert
    // chip; a read-only card with no assignee shows nothing to avoid noise.
    let assigneeControl: React.ReactNode = null;
    if (chatName) {
        if (canWrite && onAssign && members && currentUserEmail) {
            assigneeControl = (
                <AssigneePicker
                    value={assignee}
                    onChange={(email) => onAssign(chatName, email, card.title)}
                    members={members}
                    currentUserEmail={currentUserEmail}
                >
                    <button
                        type="button"
                        // items-baseline (avatar self-centres) aligns the name with the Created-by baseline.
                        className="-my-0.5 inline-flex items-baseline gap-1 rounded-sm px-1 py-0.5 hover:bg-muted"
                    >
                        {assignee ? (
                            <AssigneeChip email={assignee} />
                        ) : (
                            <span className="text-muted-foreground">Unassigned</span>
                        )}
                    </button>
                </AssigneePicker>
            );
        } else if (assignee) {
            assigneeControl = (
                <span className="inline-flex items-baseline gap-1">
                    <AssigneeChip email={assignee} />
                </span>
            );
        }
    }

    const meta =
        card.creator || assigneeControl ? (
            <span className="flex items-center gap-2">
                {card.creator && (
                    <span className="min-w-0 truncate">
                        <CreatedByMeta email={card.creator} createdAt={card.createdAt ?? 0} />
                    </span>
                )}
                {assigneeControl && <span className="ml-auto shrink-0">{assigneeControl}</span>}
            </span>
        ) : undefined;

    const canEdit = !!onUpdate && canWrite;
    const editForm =
        canEdit && isEditing ? (
            <CardForm
                key={card.id}
                mode="edit"
                initialTitle={card.title}
                initialDescription={card.description}
                initialColor={card.color ?? EIGEN_STICKIES_COLORS[0][1].value}
                allowAttachments={!!mediaFolderId}
                initialAttachments={card.attachments}
                members={members}
                currentUserEmail={currentUserEmail}
                initialAssignee={assignee}
                onSave={async (patch, drafts, assignee) => {
                    await handleEditSave(patch, drafts, assignee);
                    onEditingChange(false);
                }}
                onCancel={() => onEditingChange(false)}
            />
        ) : undefined;

    const handleOpenChange = (next: boolean) => {
        if (!next) onEditingChange(false);
        onOpenChange(next);
    };

    return (
        <NoteCardDialog
            open={open}
            onOpenChange={handleOpenChange}
            title={card.title}
            description={card.description}
            meta={meta}
            color={card.color}
            canWrite={canWrite}
            onEdit={canEdit ? () => onEditingChange(true) : undefined}
            editForm={editForm}
            copyLinkUrl={copyLinkUrl}
            onDescriptionChange={onUpdate ? (html) => onUpdate({ description: html }) : undefined}
            attachments={
                card.attachments && card.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
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
                ) : undefined
            }
            {...action}
        >
            {card.chatName ? (
                <CommentThread ownerId={ownerId} mountId={mountId} chatName={card.chatName} className="h-full" />
            ) : (
                <div className="px-4 pb-4 text-sm text-muted-foreground">No chat available for this card.</div>
            )}
        </NoteCardDialog>
    );
}
