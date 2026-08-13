import type { EffectiveMember } from '@workspace/lib/types/drive';
import { ContextMenuAnchor, type useContextMenu } from '../context-menu';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../dropdown-menu';
import { type CommentContextMenuItem, CommentMenuItems } from './comment-menu-items';

type CommentContextMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    noun?: string;
    onOpen: (cardId: string) => void;
    onUpdateCard: (cardId: string, patch: { color: string }) => void;
    onResolve: (chatName: string, status: 'open' | 'resolved', title?: string) => void;
    onDelete: (cardId: string) => void;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onAssign?: (chatName: string, email: string | null, title?: string) => void;
};

export function CommentContextMenu({
    contextMenu,
    noun,
    onOpen,
    onUpdateCard,
    onResolve,
    onDelete,
    members,
    currentUserEmail,
    onAssign,
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
                onResolve={close((chatName, title) => onResolve(chatName, 'resolved', title))}
                onReopen={close((chatName, title) => onResolve(chatName, 'open', title))}
                onDelete={close(onDelete)}
                members={members}
                currentUserEmail={currentUserEmail}
                onAssign={onAssign ? close(onAssign) : undefined}
            />
        </ContextMenuAnchor>
    );
}
