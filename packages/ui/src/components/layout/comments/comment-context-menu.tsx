import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../dropdown-menu';
import { ContextMenuAnchor, type useContextMenu } from '../context-menu';
import { type CommentContextMenuItem, CommentMenuItems } from './comment-menu-items';

type CommentContextMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    noun?: string;
    onOpen: (cardId: string) => void;
    onUpdateCard: (cardId: string, patch: { color: string }) => void;
    onResolve: (chatName: string, status: 'open' | 'resolved') => void;
    onDelete: (cardId: string) => void;
};

export function CommentContextMenu({
    contextMenu,
    noun,
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
                noun={noun}
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
