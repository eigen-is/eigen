// The open comment of the comment lifecycle bundle in the card dialog, for an editor that shows its comments in one,
// such as a board. It closes through the bundle, so a thread the URL names closes by clearing ?chat=, and it copies the
// thread's link. CommentLifecycleDialogs beside it asks before a delete.

import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useEffect, useRef } from 'react';
import { CardDialog } from '../cards/card-dialog';

type CommentCardDialogProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
    onClose?: () => void;
};

export function CommentCardDialog({ lifecycle, path, canWrite, onClose }: CommentCardDialogProps) {
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
        requestDelete,
    } = lifecycle;
    const { user } = useAuth();
    const shown = !!openCard || !!openEntry;

    // A peer's delete can take the open comment away, which hides the dialog without a close. So every close runs
    // here, once the dialog is gone, and the open state clears too: an undo that brings the card back stays closed.
    const wasShown = useRef(false);
    useEffect(() => {
        if (wasShown.current && !shown) {
            setOpenCardId(null);
            onClose?.();
        }
        wasShown.current = shown;
    }, [shown, setOpenCardId, onClose]);

    return (
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
            onUpdate={(patch) => {
                if (openCard) updateCard(openCard.id, patch);
            }}
            onResolve={(chatName, next, title) => resolveComment.mutate({ chatName, status: next, title })}
            onAssign={(chatName, assignee, title) => assignComment.mutate({ chatName, assignee, title })}
            onDelete={requestDelete}
        />
    );
}
