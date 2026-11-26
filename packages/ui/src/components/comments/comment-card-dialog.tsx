// The open comment of the comment lifecycle bundle in the card dialog, for an editor that shows its comments in one,
// such as a board. It closes through the bundle, so a thread the URL names closes by clearing ?chat=, and it copies the
// thread's link. CommentLifecycleDialogs beside it asks before a delete. What it hands the card, the open comment and
// its writes, any other frame of the card takes too, such as the comments column.

import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useRef } from 'react';
import type { CardDetailProps } from '../cards/card-detail';
import { CardDialog } from '../cards/card-dialog';

type CommentCardDialogProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
    onClose?: () => void;
};

export function CommentCardDialog({ lifecycle, path, canWrite, onClose }: CommentCardDialogProps) {
    const { openCard, openEntry, setOpenCardId } = lifecycle;
    const { user } = useAuth();
    const shown = !!openCard || !!openEntry;

    // A peer's delete can take the open comment away, which hides the dialog without a close, so the host hears of
    // every close here, once the dialog is gone.
    const wasShown = useRef(false);
    useEffect(() => {
        if (wasShown.current && !shown) onClose?.();
        wasShown.current = shown;
    }, [shown, onClose]);

    return (
        <CardDialog
            open={shown}
            onOpenChange={(open) => !open && setOpenCardId(null)}
            {...lifecycleCardDetailProps(lifecycle, path, canWrite, user?.email)}
        />
    );
}

// The open comment of a lifecycle as CardDetail takes it, with its writes, for any frame, such as this dialog or the
// comments column.
export function lifecycleCardDetailProps(
    lifecycle: ReturnType<typeof useCommentLifecycle>,
    path: DrivePath,
    canWrite: boolean,
    currentUserEmail: string | undefined,
): Omit<CardDetailProps, 'children'> {
    const { updateCard, members, openCard, resolveComment, assignComment } = lifecycle;
    return {
        card: openCard,
        entry: lifecycle.openEntry,
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        canWrite,
        deleted: lifecycle.openCardDeleted,
        isEditing: lifecycle.openCardEditing,
        onEditingChange: lifecycle.setOpenCardEditing,
        copyLinkUrl: openCard ? getDriveShareUrl(path, { chat: openCard.chatName }) : undefined,
        members,
        currentUserEmail,
        onUpdate: (patch) => {
            if (openCard) updateCard(openCard.id, patch);
        },
        onResolve: (chatName, next, title) => resolveComment.mutate({ chatName, status: next, title }),
        onAssign: (chatName, assignee, title) => assignComment.mutate({ chatName, assignee, title }),
        onDelete: lifecycle.requestDelete,
    };
}
