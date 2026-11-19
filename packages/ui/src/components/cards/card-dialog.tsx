// The dialog a comment card opens into, in every host: the card's title, description and attachments, which a writer
// edits in place, its color, assignee and resolve controls, who created it, and its thread under tabs, beside or below
// it. A deleted comment opens the deleted state instead, with nothing that acts. The host's comment lifecycle decides
// which state a card is in, and it does the writes this dialog asks for.

import { wasToasted } from '@workspace/lib/api-error';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { useResolveCardAttachments } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { useAttachmentSubjects, useMediaResolver } from '@workspace/lib/drive';
import type { ChatAttachment, CommentEntry } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CommentCard, CommentCardPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { Check, Link as LinkIcon, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { AttachmentChip } from '../attachment/attachment-chip';
import { AttachmentStrip } from '../attachment/attachment-strip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { SimpleAttachmentChip } from '../attachment/simple-attachment-chip';
import { useAttachmentChipMenu } from '../attachment/use-attachment-chip-menu';
import { CreatedByMeta } from '../comments/created-by-meta';
import { DeletedComment } from '../comments/deleted-comment';
import { ContextMenuAnchor } from '../context-menu';
import { Dialog, DialogContent, DialogTitle } from '../dialog';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { FileActionMenuItems } from '../file-actions/file-action-menu-items';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { CardAttachmentRow } from './card-attachment-row';
import { CardDescription } from './card-description';
import type { ThreadPlacement } from './card-dialog-shell';
import { CardDialogShell } from './card-dialog-shell';
import { CardProperties } from './card-properties';
import { CardThreadTabs } from './card-thread-tabs';
import { CardTitle } from './card-title';

type CardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    card: CommentCard | null;
    entry?: CommentEntry;
    ownerId: string;
    mountId: string;
    // The container the card belongs to. The comment thread's notifications are tagged with it.
    pathId: string;
    canWrite?: boolean;
    deleted: boolean;
    threadPlacement: ThreadPlacement;
    copyLinkUrl?: string;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onUpdate?: (cardId: string, patch: CommentCardPatch) => void;
    onResolve?: (chatName: string, next: CommentEntry['status'], title?: string) => void;
    onAssign?: (chatName: string, assignee: string | null, title?: string) => void;
    onDelete?: (cardId: string) => void;
};

export function CardDialog({ deleted, card, entry, open, onOpenChange, ...props }: CardDialogProps) {
    // A comment whose card is gone has only its index row, which keeps the title.
    if (deleted) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent size="sm" aria-describedby={undefined}>
                    <DialogTitle className="sr-only">Deleted comment</DialogTitle>
                    <DeletedComment title={(card ? card.title : entry?.title) || 'Comment'} className="pr-8" />
                </DialogContent>
            </Dialog>
        );
    }
    if (!card) return null;
    // Keyed, so an edit that was open, and the celebration's one try, never carry over to another card.
    return (
        <OpenCardDialog key={card.id} card={card} entry={entry} open={open} onOpenChange={onOpenChange} {...props} />
    );
}

type EditField = 'title' | 'description';

function OpenCardDialog({
    open,
    onOpenChange,
    card,
    entry,
    ownerId,
    mountId,
    pathId,
    canWrite = true,
    threadPlacement,
    copyLinkUrl,
    members,
    currentUserEmail,
    onUpdate,
    onResolve,
    onAssign,
    onDelete,
}: Omit<CardDialogProps, 'deleted' | 'card'> & { card: CommentCard }) {
    const { mediaFolderId } = useMediaResolver();
    const resolveAttachments = useResolveCardAttachments(ownerId, mountId, mediaFolderId);
    const { subjectOf, subjectsOf } = useAttachmentSubjects(ownerId, mountId, mediaFolderId);
    // A chip's file actions open on right-click, and on touch through the long-press the chips share.
    const { contextMenu: chipMenu, bind } = useAttachmentChipMenu<FileSubject>(subjectOf);
    const attachmentSubjects = useMemo(() => subjectsOf(card.attachments), [card.attachments, subjectsOf]);
    // The card's own attachments are the siblings, so a quick look from here keeps its Save all row.
    const runner = useFileActionRunner(chipMenu.item, attachmentSubjects);
    const [pickerOpen, setPickerOpen] = useState(false);

    // The ref answers at once, because a field removed while it has the focus can still report a blur, and that blur
    // must not save an edit that was just cancelled or saved.
    const [editing, setEditingState] = useState<EditField | null>(null);
    const editingRef = useRef<EditField | null>(null);
    const setEditing = (field: EditField | null) => {
        editingRef.current = field;
        setEditingState(field);
    };
    const save = (field: EditField, patch: CommentCardPatch | null) => {
        if (editingRef.current !== field) return;
        setEditing(null);
        if (patch) onUpdate?.(card.id, patch);
    };

    const canEdit = canWrite && !!onUpdate;
    const canAttach = canEdit && !!mediaFolderId;
    // A thread without an index row reads as open and unassigned, as the comment filter reads it. Its first message or
    // assignment creates the row on the server.
    const chatName = card.chatName;
    const status = entry?.status ?? 'open';

    // Each file lands on its own as its upload ends, so one failure doesn't strand the others.
    const attach = (drafts: CardAttachmentDraft[]) => {
        for (const draft of drafts) {
            resolveAttachments([draft])
                .then((added) => onUpdate?.(card.id, { attachments: (current) => [...current, ...added] }))
                .catch((error) => {
                    if (!wasToasted(error)) throw error;
                });
        }
    };
    const detach = (attachment: ChatAttachment) =>
        onUpdate?.(card.id, {
            attachments: (current) =>
                current.filter((a) =>
                    typeof a === 'string' || typeof attachment === 'string' ? a !== attachment : a.id !== attachment.id,
                ),
        });
    // Only the card's column takes a file, as the reply box takes its own for the message.
    const { targetProps } = useFileDropTarget(attach, canAttach);
    const { onPaste } = useFilePasteTarget(attach, canAttach);

    const attachmentNames = card.attachments?.filter((name): name is string => typeof name === 'string') ?? [];

    return (
        <CardDialogShell
            open={open}
            onOpenChange={onOpenChange}
            color={card.color}
            unsaved={editing !== null}
            onCancel={() => setEditing(null)}
            title={
                <>
                    {chatName && status === 'resolved' && (
                        <Check className="h-4 w-4 shrink-0" aria-label="Resolved" role="img" />
                    )}
                    <CardTitle
                        title={card.title}
                        canWrite={canEdit}
                        editing={editing === 'title'}
                        onEdit={() => setEditing('title')}
                        onSave={(title) => save('title', title === null ? null : { title })}
                    />
                </>
            }
            footer={
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {card.creator && <CreatedByMeta email={card.creator} createdAt={card.createdAt ?? 0} />}
                    <span className="ml-auto flex shrink-0 items-center">
                        {copyLinkUrl && (
                            <TooltipButton
                                icon={LinkIcon}
                                tooltipText="Copy link"
                                className="h-7 w-7"
                                onClick={() => copyToClipboard(copyLinkUrl, 'Link copied to clipboard')}
                            />
                        )}
                        {canWrite && onDelete && (
                            <TooltipButton
                                icon={Trash2}
                                tooltipText="Delete"
                                className="h-7 w-7"
                                onClick={() => onDelete(card.id)}
                            />
                        )}
                    </span>
                </div>
            }
            thread={{
                placement: threadPlacement,
                content: chatName ? (
                    <CardThreadTabs
                        ownerId={ownerId}
                        mountId={mountId}
                        pathId={pathId}
                        chatName={chatName}
                        placement={threadPlacement}
                    />
                ) : (
                    <div className="p-4 text-sm text-muted-foreground">No chat available for this card.</div>
                ),
            }}
        >
            <div className="flex min-h-full flex-col gap-4" onPaste={onPaste} {...targetProps}>
                <CardDescription
                    description={card.description}
                    canWrite={canEdit}
                    editing={editing === 'description'}
                    onEdit={() => setEditing('description')}
                    onCancel={() => setEditing(null)}
                    onSave={(html) => save('description', html === null ? null : { description: html })}
                    onTick={(html) => onUpdate?.(card.id, { description: html })}
                />
                <div className="mt-auto flex flex-col gap-3">
                    <CardAttachmentRow
                        onAdd={canAttach ? () => setPickerOpen(true) : undefined}
                        hasAttachments={!!card.attachments?.length}
                    >
                        {!!card.attachments?.length && (
                            <AttachmentStrip className="min-w-0 flex-1" {...bind()}>
                                {card.attachments.map((attachment) => {
                                    const onRemove = canEdit ? () => detach(attachment) : undefined;
                                    if (isAttachmentReference(attachment)) {
                                        return (
                                            <ReferenceAttachmentChip
                                                key={`ref-${attachment.id}`}
                                                reference={attachment}
                                                onRemove={onRemove}
                                            />
                                        );
                                    }
                                    return mediaFolderId ? (
                                        <AttachmentChip
                                            key={`name-${attachment}`}
                                            fileName={attachment}
                                            ownerId={ownerId}
                                            mountId={mountId}
                                            mediaFolderId={mediaFolderId}
                                            siblingFileNames={attachmentNames}
                                            onRemove={onRemove}
                                        />
                                    ) : (
                                        <SimpleAttachmentChip
                                            key={`name-${attachment}`}
                                            filename={attachment}
                                            onRemove={onRemove}
                                        />
                                    );
                                })}
                            </AttachmentStrip>
                        )}
                    </CardAttachmentRow>
                    <CardProperties
                        color={card.color ?? EIGEN_STICKIES_COLORS[0][1].value}
                        onColorChange={canEdit ? (color) => onUpdate?.(card.id, { color }) : undefined}
                        assignee={entry?.assignee ?? null}
                        onAssigneeChange={
                            canWrite && chatName && onAssign
                                ? (email) => onAssign(chatName, email, card.title)
                                : undefined
                        }
                        members={members}
                        currentUserEmail={currentUserEmail}
                        status={chatName ? status : undefined}
                        onStatusChange={
                            canWrite && chatName && onResolve
                                ? (next) => onResolve(chatName, next, card.title)
                                : undefined
                        }
                    />
                </div>
            </div>
            <ContextMenuAnchor contextMenu={chipMenu} className="min-w-48">
                <FileActionMenuItems runner={runner} />
            </ContextMenuAnchor>
            {runner.dialogs}
            {canAttach && (
                <DrivePickerWithUpload
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    multiSelect
                    multiple
                    onPickFromDrive={attach}
                    onPickFromDevice={attach}
                />
            )}
        </CardDialogShell>
    );
}
