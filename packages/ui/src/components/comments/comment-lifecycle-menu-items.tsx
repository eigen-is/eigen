import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import { type CommentContextMenuItem, CommentMenuItems, type CommentMenuPrimitives } from './comment-menu-items';

// Binds the shared comment rows to the lifecycle bundle so every host — the stickies/docs/vector
// context menu, slides' object menu, sheets' cell menu — offers the same actions from one wiring,
// and a new row lands in all of them at once. Hosts supply only what is anchor-specific: the item
// under the cursor, add and delete. Selecting any row closes the host menu on its own — every row is
// a real menu item, and the anchor turns Radix's close into the context menu's own `close()`.
type CommentLifecycleMenuItemsProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    primitives: CommentMenuPrimitives;
    item: CommentContextMenuItem | null;
    canWrite: boolean;
    noun?: string;
    onAddComment?: () => void;
    onDelete?: (cardId: string) => void;
};

export function CommentLifecycleMenuItems({
    lifecycle,
    primitives,
    item,
    canWrite,
    noun,
    onAddComment,
    onDelete,
}: CommentLifecycleMenuItemsProps) {
    const { setOpenCardId, openCardForEdit, updateCard, resolveComment, assignComment, members } = lifecycle;
    const { user } = useAuth();

    return (
        <CommentMenuItems
            primitives={primitives}
            item={item}
            noun={noun}
            onAddComment={canWrite ? onAddComment : undefined}
            onOpen={setOpenCardId}
            onEdit={canWrite ? openCardForEdit : undefined}
            onChangeColor={canWrite ? (cardId, color) => updateCard(cardId, { color }) : undefined}
            onResolve={
                canWrite
                    ? (chatName, title) => resolveComment.mutate({ chatName, status: 'resolved', title })
                    : undefined
            }
            onReopen={
                canWrite ? (chatName, title) => resolveComment.mutate({ chatName, status: 'open', title }) : undefined
            }
            onDelete={canWrite ? onDelete : undefined}
            members={members}
            currentUserEmail={user?.email}
            onAssign={
                canWrite
                    ? (chatName, email, title) => assignComment.mutate({ chatName, assignee: email, title })
                    : undefined
            }
        />
    );
}
