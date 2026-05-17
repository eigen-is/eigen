import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { ContextMenuAnchor, type useContextMenu } from '../context-menu';
import { NoteCardContextMenu } from '../notes/note-card-context-menu';

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
    return (
        <ContextMenuAnchor contextMenu={contextMenu}>
            <NoteCardContextMenu
                currentColor={contextMenu.item?.card.color}
                status={contextMenu.item?.entry?.status}
                onEdit={() => {
                    if (contextMenu.item) onOpen(contextMenu.item.card.id);
                    contextMenu.close();
                }}
                onChangeColor={(color) => {
                    if (contextMenu.item) onUpdateCard(contextMenu.item.card.id, { color });
                    contextMenu.close();
                }}
                onResolve={() => {
                    const entry = contextMenu.item?.entry;
                    if (entry) onResolve(entry.chatName, 'resolved');
                    contextMenu.close();
                }}
                onReopen={() => {
                    const entry = contextMenu.item?.entry;
                    if (entry) onResolve(entry.chatName, 'open');
                    contextMenu.close();
                }}
                onDelete={() => {
                    if (contextMenu.item) onDelete(contextMenu.item.card.id);
                    contextMenu.close();
                }}
            />
        </ContextMenuAnchor>
    );
}
