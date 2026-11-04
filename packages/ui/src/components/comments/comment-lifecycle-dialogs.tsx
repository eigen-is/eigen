// The card dialog and the comment right-click menu every editor mounts, driven by the comment lifecycle bundle. The
// editor owns the context menu's state and supplies the delete that strips its own anchor, such as a mark in docs or a
// cell's card ids in sheets. Everything else, the deleted state included, comes from the bundle.

import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useRef } from 'react';
import { CardDialog } from '../cards/card-dialog';
import type { useContextMenu } from '../context-menu';
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
    noun,
    onCardDialogClose,
}: CommentLifecycleDialogsProps) {
    const { updateCard, members, openCard, openEntry, openCardDeleted, setOpenCardId, resolveComment, assignComment } =
        lifecycle;
    const { user } = useAuth();
    const shown = !!openCard || !!openEntry;

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
                onOpenChange={(o) => !o && setOpenCardId(null)}
                card={openCard}
                entry={openEntry}
                ownerId={path.ownerId}
                mountId={path.mountId}
                pathId={path.id}
                canWrite={canWrite}
                deleted={openCardDeleted}
                isEditing={lifecycle.openCardEditing}
                onEditingChange={lifecycle.setOpenCardEditing}
                copyLinkUrl={openCard?.chatName ? getDriveItemUrl(path, { chat: openCard.chatName }) : undefined}
                members={members}
                currentUserEmail={user?.email}
                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                onResolve={(chatName, next, title) => resolveComment.mutate({ chatName, status: next, title })}
                onAssign={(chatName, assignee, title) => assignComment.mutate({ chatName, assignee, title })}
            />

            <CommentContextMenu
                contextMenu={commentContextMenu}
                lifecycle={lifecycle}
                canWrite={canWrite}
                noun={noun}
                onDelete={onDelete}
            />
        </>
    );
}
