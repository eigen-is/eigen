import type { useCommentLifecycle } from '@workspace/lib/comments';
import { ContextMenuAnchor, type useContextMenu } from '../context-menu';
import { CommentLifecycleMenuItems } from './comment-lifecycle-menu-items';
import type { CommentContextMenuItem } from './comment-menu-items';

type CommentContextMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    canWrite: boolean;
    noun?: string;
    onDelete: (cardId: string) => void;
};

export function CommentContextMenu({ contextMenu, lifecycle, canWrite, noun, onDelete }: CommentContextMenuProps) {
    return (
        <ContextMenuAnchor contextMenu={contextMenu}>
            <CommentLifecycleMenuItems
                lifecycle={lifecycle}
                item={contextMenu.item ?? null}
                canWrite={canWrite}
                noun={noun}
                onDelete={onDelete}
            />
        </ContextMenuAnchor>
    );
}
