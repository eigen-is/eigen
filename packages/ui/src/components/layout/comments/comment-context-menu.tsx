import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../dropdown-menu';
import { ContextMenuAnchor, type useContextMenu } from '../context-menu';
import { CommentMenuItems } from './comment-menu-items';

export type CommentContextMenuItem = { card: CommentCard; entry: CommentEntry | undefined };

type CommentContextMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onOpen: (cardId: string) => void;
    onUpdateCard: (cardId: string, patch: { color: string }) => void;
    onResolve: (chatName: string, status: 'open' | 'resolved') => void;
    onDelete: (cardId: string) => void;
};

export function CommentContextMenu({
    contextMenu,
    onOpen,
    onUpdateCard,
    onResolve,
    onDelete,
}: CommentContextMenuProps) {
    const close =
        <Args extends unknown[]>(fn: (...args: Args) => void) =>
        (...args: Args) => {
            fn(...args);
            contextMenu.close();
        };
    return (
        <ContextMenuAnchor contextMenu={contextMenu}>
            <CommentMenuItems
                primitives={{
                    Item: DropdownMenuItem,
                    Sub: DropdownMenuSub,
                    SubTrigger: DropdownMenuSubTrigger,
                    SubContent: DropdownMenuSubContent,
                }}
                item={contextMenu.item ?? null}
                onOpen={close(onOpen)}
                onChangeColor={close((cardId, color) => onUpdateCard(cardId, { color }))}
                onResolve={close((chatName) => onResolve(chatName, 'resolved'))}
                onReopen={close((chatName) => onResolve(chatName, 'open'))}
                onDelete={close(onDelete)}
            />
        </ContextMenuAnchor>
    );
}
