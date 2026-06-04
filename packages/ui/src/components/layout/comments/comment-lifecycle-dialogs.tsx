import { getDriveItemUrl } from '@workspace/lib/api';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CardDialog } from '../cards/card-dialog';
import type { useContextMenu } from '../context-menu';
import { CommentContextMenu, type CommentContextMenuItem } from './comment-context-menu';

// Renders the view/edit dialog + right-click menu shared verbatim by the docs / slides / sheets
// editors. The editor owns the `useContextMenu` instance (a ui-layer primitive) and supplies the
// per-app `onDelete` that strips the host anchor; everything else is driven by the lifecycle bundle.
type CommentLifecycleDialogsProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onDelete: (cardId: string) => void;
};

export function CommentLifecycleDialogs({
    lifecycle,
    path,
    canWrite,
    commentContextMenu,
    onDelete,
}: CommentLifecycleDialogsProps) {
    const { updateCard, resolveComment, openCard, openEntry, setOpenCardId } = lifecycle;

    return (
        <>
            <CardDialog
                open={!!openCard}
                onOpenChange={(o) => {
                    if (!o) setOpenCardId(null);
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
                showResolveAction
                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                onResolve={(chatName, next) => resolveComment.mutate({ chatName, status: next })}
            />

            <CommentContextMenu
                contextMenu={commentContextMenu}
                onOpen={setOpenCardId}
                onUpdateCard={updateCard}
                onResolve={(chatName, status) => resolveComment.mutate({ chatName, status })}
                onDelete={onDelete}
            />
        </>
    );
}
