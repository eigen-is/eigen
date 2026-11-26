// A comment's right-click menu, such as a mark's in docs or a card's on a board: the shared comment rows at the
// pointer, bound to the comment lifecycle bundle. CommentLifecycleDialogs mounts it beside the delete confirm.

import type { useContextMenu } from '../context-menu';
import { ContextMenuAnchor } from '../context-menu';
import { CommentLifecycleMenuItems } from './comment-lifecycle-menu-items';
import type { CommentContextMenuItem } from './comment-menu-items';
import type { CommentLifecycleBundle } from './use-comment-host';

type CommentContextMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    lifecycle: CommentLifecycleBundle;
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
