import { getDriveItemUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CardDialog } from '../cards/card-dialog';
import type { useContextMenu } from '../context-menu';
import { CommentContextMenu } from './comment-context-menu';
import type { CommentContextMenuItem } from './comment-menu-items';

// Renders the view/edit dialog + right-click menu shared verbatim by the docs / slides / sheets /
// stickies editors. The editor owns the `useContextMenu` instance (a ui-layer primitive) and
// supplies the per-app `onDelete` that strips the host anchor; everything else is driven by the
// lifecycle bundle.
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
    const { updateCard, resolveComment, assignComment, members, openCard, openEntry, setOpenCardId } = lifecycle;
    const { user } = useAuth();

    return (
        <>
            <CardDialog
                open={!!openCard}
                onOpenChange={(o) => {
                    if (!o) {
                        setOpenCardId(null);
                        onCardDialogClose?.();
                    }
                }}
                card={openCard}
                entry={openEntry}
                ownerId={path.ownerId}
                mountId={path.mountId}
                canWrite={canWrite}
                copyLinkUrl={
                    openCard?.chatName
                        ? `${getDriveItemUrl(path)}?chat=${encodeURIComponent(openCard.chatName)}`
                        : undefined
                }
                members={members}
                currentUserEmail={user?.email}
                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                onResolve={(chatName, next, title) => resolveComment.mutate({ chatName, status: next, title })}
                onAssign={(chatName, assignee, title) => assignComment.mutate({ chatName, assignee, title })}
            />

            <CommentContextMenu
                contextMenu={commentContextMenu}
                noun={noun}
                onOpen={setOpenCardId}
                onUpdateCard={updateCard}
                onResolve={(chatName, status, title) => resolveComment.mutate({ chatName, status, title })}
                onDelete={onDelete}
                members={members}
                currentUserEmail={user?.email}
                onAssign={(chatName, email, title) => assignComment.mutate({ chatName, assignee: email, title })}
            />
        </>
    );
}
