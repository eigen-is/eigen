// An opened comment card in whatever frame its host gives it, such as the card dialog or the comments column: its
// link, edit and resolve actions for the host's bar, then the card's title, description, attachments and assignee with
// its thread below in one scroll, and the edit form while the card is edited. A deleted comment gives the deleted
// state, with nothing that acts. The host's comment lifecycle decides which state a card is in, and does the writes.

import { useResolveCardAttachments } from '@workspace/lib/comments';
import { useAttachmentSubjects, useMediaResolver } from '@workspace/lib/drive';
import type { ChatAttachment, CommentEntry } from '@workspace/lib/types/chat';
import { isAttachmentReference } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { Check, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { DialogAction } from '../../hooks/use-dialog-pending';
import { AttachmentChip } from '../attachment/attachment-chip';
import { AttachmentStrip } from '../attachment/attachment-strip';
import { ReferenceAttachmentChip } from '../attachment/reference-attachment-chip';
import { SimpleAttachmentChip } from '../attachment/simple-attachment-chip';
import { useAttachmentChipMenu } from '../attachment/use-attachment-chip-menu';
import { AssigneeChip } from '../comments/assignee-chip';
import { AssigneePicker } from '../comments/assignee-picker';
import { CommentThread } from '../comments/comment-thread';
import { CreatedByMeta } from '../comments/created-by-meta';
import { DeletedComment } from '../comments/deleted-comment';
import { ContextMenuAnchor } from '../context-menu';
import { FileActionMenuItems } from '../file-actions/file-action-menu-items';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { CardBody } from './card-body';
import { CardDialogActions } from './card-dialog-actions';
import { CardForm } from './card-form';

// What the frame around the edit form gives it: its save lifecycle, which ends the edit once a save lands, an ear for
// whether the form changed, so its closes can ask "Discard changes?", and the title its dialog names the form with.
export type CardEditFrame = {
    pending: boolean;
    run: (action: DialogAction) => Promise<false | undefined>;
    onChangedChange: (changed: boolean) => void;
    dialogTitle?: string;
};

export type CardDetailParts = {
    title: string;
    deleted: boolean;
    actions: ReactNode;
    body: ReactNode;
    // Set only while the card is edited, so a frame shows it in place of the body or in a dialog of its own.
    editForm: ((frame: CardEditFrame) => ReactNode) | null;
};

export type CardDetailProps = {
    card: CommentCard | null;
    entry?: CommentEntry;
    ownerId: string;
    mountId: string;
    // The container the card belongs to. The comment thread's notifications are tagged with it.
    pathId: string;
    canWrite?: boolean;
    deleted: boolean;
    // Edit mode is owned by the lifecycle bundle so the menus' Edit row can open straight into it.
    isEditing: boolean;
    onEditingChange: (editing: boolean) => void;
    copyLinkUrl?: string;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onUpdate?: (patch: CardFormPatch & { attachments?: ChatAttachment[] }) => void | Promise<void>;
    onResolve?: (chatName: string, next: 'open' | 'resolved', title?: string) => void;
    onAssign?: (chatName: string, assignee: string | null, title?: string) => void;
    onDelete?: (cardId: string) => void;
    // Whether the thread's reply box takes the focus as it shows.
    autoFocus?: boolean;
    // The frame, given null while no card is open, so a frame that stays, such as a column over its list, keeps its
    // place.
    children: (parts: CardDetailParts | null) => ReactNode;
};

export function CardDetail({
    card,
    entry,
    ownerId,
    mountId,
    pathId,
    canWrite = true,
    deleted,
    isEditing,
    onEditingChange,
    copyLinkUrl,
    members,
    currentUserEmail,
    onUpdate,
    onResolve,
    onAssign,
    onDelete,
    autoFocus,
    children,
}: CardDetailProps) {
    const { mediaFolderId } = useMediaResolver();
    const resolveAttachments = useResolveCardAttachments(ownerId, mountId, mediaFolderId);
    const { subjectOf, subjectsOf } = useAttachmentSubjects(ownerId, mountId, mediaFolderId);
    // A chip's file actions open on right-click, and on touch through the long-press the chips share.
    const { contextMenu: chipMenu, bind } = useAttachmentChipMenu<FileSubject>(subjectOf);
    const attachmentSubjects = useMemo(() => subjectsOf(card?.attachments), [card?.attachments, subjectsOf]);
    // The card's own attachments are the siblings, so a quick look from here keeps its Save all row.
    const runner = useFileActionRunner(chipMenu.item, attachmentSubjects);

    // A comment whose card is gone has only its index row, which keeps the title.
    if (deleted) {
        const title = (card ? card.title : entry?.title) || 'Comment';
        return children({ title, deleted, actions: null, body: <DeletedComment title={title} />, editForm: null });
    }

    if (!card) return children(null);

    // A thread without an index row reads as open and unassigned, as the comment filter reads it. Its first message or
    // assignment creates the row on the server.
    const { chatName } = card;
    const status = entry?.status ?? 'open';
    const assignee = entry?.assignee ?? null;

    // Resolve and reopen are writes, so they are gated like the menus' rows and the Edit pencil. A viewer would only
    // get the 403 the route answers with.
    const action =
        canWrite && onResolve
            ? {
                  actionIcon: status === 'open' ? Check : RotateCcw,
                  actionTooltip: status === 'open' ? 'Resolve' : 'Reopen',
                  onAction: () => onResolve(chatName, status === 'open' ? 'resolved' : 'open', card.title),
              }
            : {};

    const attachmentNames = card.attachments?.filter((name): name is string => typeof name === 'string') ?? [];

    const handleEditSave = async (patch: CardFormPatch, drafts?: CardAttachmentDraft[], assignee?: string | null) => {
        // The same Save may rename the card. The new title goes along, so the activity row and the title cache don't
        // record the old name.
        if (assignee !== undefined) onAssign?.(chatName, assignee, patch.title ?? card.title);
        if (!onUpdate) return;
        if (drafts === undefined) {
            await onUpdate(patch);
            return;
        }
        const attachments = await resolveAttachments(drafts);
        await onUpdate({ ...patch, attachments });
    };

    // The assignee sits in the meta row: a picker when the user may reassign, else a plain chip. A read-only card with
    // no assignee shows nothing there.
    let assigneeControl: ReactNode = null;
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
                    // items-baseline lines the name up with the Created by text. The avatar centers itself.
                    className="-mx-1 -my-0.5 inline-flex items-baseline gap-1 rounded-sm px-1 py-0.5 hover:bg-muted"
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

    // Who made the card on the left, who it is for on the right. On a narrow screen the creator's name gives way first.
    const meta =
        card.creator || assigneeControl ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
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
        canEdit && isEditing
            ? ({ pending, run, onChangedChange, dialogTitle }: CardEditFrame) => (
                  <CardForm
                      key={card.id}
                      mode="edit"
                      dialogTitle={dialogTitle}
                      initialTitle={card.title}
                      initialDescription={card.description}
                      initialColor={card.color}
                      allowAttachments={!!mediaFolderId}
                      initialAttachments={card.attachments}
                      members={members}
                      currentUserEmail={currentUserEmail}
                      initialAssignee={assignee}
                      onSave={(patch, drafts, assignee) => run(() => handleEditSave(patch, drafts, assignee))}
                      pending={pending}
                      onCancel={() => onEditingChange(false)}
                      onChangedChange={onChangedChange}
                      onDelete={onDelete && (() => onDelete(card.id))}
                  />
              )
            : null;

    const content = (
        <CardBody
            title={card.title}
            description={card.description}
            meta={meta}
            color={card.color}
            canWrite={canWrite}
            onDescriptionChange={onUpdate ? (html) => onUpdate({ description: html }) : undefined}
            attachments={
                card.attachments && card.attachments.length > 0 ? (
                    <>
                        <AttachmentStrip {...bind()}>
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
                        </AttachmentStrip>
                        <ContextMenuAnchor contextMenu={chipMenu} className="min-w-48">
                            <FileActionMenuItems runner={runner} />
                        </ContextMenuAnchor>
                        {runner.dialogs}
                    </>
                ) : undefined
            }
        />
    );

    return children({
        title: card.title,
        deleted: false,
        actions: (
            <CardDialogActions
                copyLinkUrl={copyLinkUrl}
                onEdit={canEdit ? () => onEditingChange(true) : undefined}
                {...action}
            />
        ),
        body: (
            <CommentThread
                ownerId={ownerId}
                mountId={mountId}
                pathId={pathId}
                chatName={chatName}
                lead={content}
                autoFocus={autoFocus}
            />
        ),
        editForm,
    });
}
