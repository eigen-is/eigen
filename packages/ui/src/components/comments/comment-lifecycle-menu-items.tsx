// Binds the shared comment rows to the comment lifecycle bundle, so every host's menu, such as a card's right-click
// menu or the sheet's cell menu, offers the same actions and a new row lands in all of them at once. A host supplies
// only what its anchor decides: the item under the cursor, add and delete. Every row is a real menu item, so picking
// one closes the host's menu.

import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentMenuItems } from './comment-menu-items';

type CommentLifecycleMenuItemsProps = {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    item: CommentContextMenuItem | null;
    canWrite: boolean;
    noun?: string;
    onAddComment?: () => void;
    onDelete?: (cardId: string) => void;
    part?: 'rows' | 'delete';
};

export function CommentLifecycleMenuItems({
    lifecycle,
    item,
    canWrite,
    noun,
    onAddComment,
    onDelete,
    part,
}: CommentLifecycleMenuItemsProps) {
    const { setOpenCardId, openCardForEdit, updateCard, resolveComment, assignComment, members, isCardDeleted } =
        lifecycle;
    const { user } = useAuth();
    // A deleted comment keeps only View and Delete: its thread is gone, or the document no longer uses it.
    const canChange = canWrite && !(item && isCardDeleted(item.card));

    return (
        <CommentMenuItems
            item={item}
            noun={noun}
            part={part}
            onAddComment={canWrite ? onAddComment : undefined}
            onOpen={setOpenCardId}
            onEdit={canChange ? openCardForEdit : undefined}
            onChangeColor={canChange ? (cardId, color) => updateCard(cardId, { color }) : undefined}
            onResolve={
                canChange
                    ? (chatName, title) => resolveComment.mutate({ chatName, status: 'resolved', title })
                    : undefined
            }
            onReopen={
                canChange ? (chatName, title) => resolveComment.mutate({ chatName, status: 'open', title }) : undefined
            }
            onDelete={canWrite ? onDelete : undefined}
            members={members}
            currentUserEmail={user?.email}
            onAssign={
                canChange
                    ? (chatName, email, title) => assignComment.mutate({ chatName, assignee: email, title })
                    : undefined
            }
        />
    );
}
