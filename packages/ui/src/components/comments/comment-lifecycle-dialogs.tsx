// The card dialog and the comment right-click menu every editor mounts, driven by the comment lifecycle bundle. The
// editor owns the context menu's state and supplies the delete that strips its own anchor, such as a mark in docs or a
// cell's card ids in sheets. A delete from the dialog's edit form or that menu asks first, through DeleteCommentDialog,
// so every editor asks the same way. Everything else, the deleted state included, comes from the bundle.

import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useRef, useState } from 'react';
import { CardDialog } from '../cards/card-dialog';
import type { useContextMenu } from '../context-menu';
import type { DeleteDialogProps } from '../delete/delete-dialog';
import { DeleteDialog } from '../delete/delete-dialog';
import { CommentContextMenu } from './comment-context-menu';
import type { CommentContextMenuItem } from './comment-menu-items';

type CommentLifecycleDialogsProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onDelete: (cardId: string) => void;
    noun?: string;
    onCardDialogClose?: () => void;
};

export function CommentLifecycleDialogs({
    lifecycle,
    path,
    canWrite,
    commentContextMenu,
    onDelete,
    noun = 'comment',
    onCardDialogClose,
}: CommentLifecycleDialogsProps) {
    const {
        updateCard,
        members,
        openCard,
        openEntry,
        openCardDeleted,
        openCardEditing,
        setOpenCardEditing,
        setOpenCardId,
        resolveComment,
        assignComment,
    } = lifecycle;
    const { user } = useAuth();
    const shown = !!openCard || !!openEntry;
    const [deleteCardId, setDeleteCardId] = useState<string | null>(null);

    // A peer's delete can take the open comment away, which hides the dialog without a close. So every close runs
    // here, once the dialog is gone, and the open state clears too: an undo that brings the card back stays closed.
    const wasShown = useRef(false);
    useEffect(() => {
        if (wasShown.current && !shown) {
            setOpenCardId(null);
            onCardDialogClose?.();
        }
        wasShown.current = shown;
    }, [shown, setOpenCardId, onCardDialogClose]);

    return (
        <>
            <CardDialog
                open={shown}
                onOpenChange={(open) => !open && setOpenCardId(null)}
                card={openCard}
                entry={openEntry}
                ownerId={path.ownerId}
                mountId={path.mountId}
                pathId={path.id}
                canWrite={canWrite}
                deleted={openCardDeleted}
                isEditing={openCardEditing}
                onEditingChange={setOpenCardEditing}
                copyLinkUrl={openCard?.chatName ? getDriveShareUrl(path, { chat: openCard.chatName }) : undefined}
                members={members}
                currentUserEmail={user?.email}
                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                onResolve={(chatName, next, title) => resolveComment.mutate({ chatName, status: next, title })}
                onAssign={(chatName, assignee, title) => assignComment.mutate({ chatName, assignee, title })}
                onDelete={setDeleteCardId}
            />

            <CommentContextMenu
                contextMenu={commentContextMenu}
                lifecycle={lifecycle}
                canWrite={canWrite}
                noun={noun}
                onDelete={setDeleteCardId}
            />

            <DeleteCommentDialog
                open={!!deleteCardId}
                onOpenChange={(open) => !open && setDeleteCardId(null)}
                noun={noun}
                onDelete={() => {
                    if (deleteCardId) onDelete(deleteCardId);
                    // In a host that keeps a deleted card, the dialog would stay open on the deleted state.
                    setOpenCardId(null);
                }}
            />
        </>
    );
}

type DeleteCommentDialogProps = Omit<DeleteDialogProps, 'title' | 'description'> & { noun?: string };

// The ask before a comment and its replies go, in the words every editor uses. A host that opens it from a menu of
// its own, such as a sheet's cell menu, mounts it there and says where the focus goes as it closes.
export function DeleteCommentDialog({ noun = 'comment', ...props }: DeleteCommentDialogProps) {
    return (
        <DeleteDialog {...props} title={`Delete ${noun}`} description={`This deletes the ${noun} and its replies.`} />
    );
}
