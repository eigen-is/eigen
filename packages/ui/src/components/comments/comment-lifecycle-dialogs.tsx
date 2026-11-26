// The comment right-click menu and the delete confirm every editor mounts, driven by the comment lifecycle bundle. The
// editor owns the context menu's state and supplies the delete that strips its own anchor, such as a mark in docs or a
// cell's card ids in sheets. A delete from the card's edit form or that menu asks first, through DeleteCommentDialog,
// so every editor asks the same way, and then the comment, if open, closes as its host closes a thread.

import type { ConfirmDialogProps } from '../confirm-dialog';
import { ConfirmDialog } from '../confirm-dialog';
import type { useContextMenu } from '../context-menu';
import { CommentContextMenu } from './comment-context-menu';
import type { CommentContextMenuItem } from './comment-menu-items';
import type { CommentLifecycleBundle } from './use-comment-host';

type CommentLifecycleDialogsProps = {
    lifecycle: CommentLifecycleBundle;
    canWrite: boolean;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onDelete: (cardId: string) => void;
    noun?: string;
};

export function CommentLifecycleDialogs({
    lifecycle,
    canWrite,
    commentContextMenu,
    onDelete,
    noun = 'comment',
}: CommentLifecycleDialogsProps) {
    const { deleteCardId, requestDelete, openCard, setOpenCardId } = lifecycle;

    return (
        <>
            <CommentContextMenu
                contextMenu={commentContextMenu}
                lifecycle={lifecycle}
                canWrite={canWrite}
                noun={noun}
                onDelete={requestDelete}
            />

            <DeleteCommentDialog
                open={!!deleteCardId}
                onOpenChange={(open) => !open && requestDelete(null)}
                noun={noun}
                onConfirm={() => {
                    if (!deleteCardId) return;
                    onDelete(deleteCardId);
                    // A host that keeps a deleted card would otherwise show it open in its deleted state.
                    if (deleteCardId === openCard?.id) setOpenCardId(null);
                }}
            />
        </>
    );
}

type DeleteCommentDialogProps = Pick<ConfirmDialogProps, 'open' | 'onOpenChange' | 'onConfirm' | 'onCloseAutoFocus'> & {
    noun?: string;
};

// The ask before a comment and its replies go, in the words every editor uses. A host that opens it from a menu of
// its own, such as a sheet's cell menu, mounts it there and says where the focus goes as it closes.
export function DeleteCommentDialog({ noun = 'comment', ...props }: DeleteCommentDialogProps) {
    return (
        <ConfirmDialog
            {...props}
            title={`Delete ${noun}`}
            description={`This deletes the ${noun} and its replies.`}
            confirmText="Delete"
            destructive
        />
    );
}
