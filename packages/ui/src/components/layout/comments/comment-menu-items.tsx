import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { Check, MessageSquarePlus, Palette, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { ElementType } from 'react';
import { ColorSwatchRow } from '../notes/color-swatch-row';

export type CommentMenuItem = { card: CommentCard; entry: CommentEntry | undefined };

// Slot for the menu primitives so the same items can render inside either a
// Radix ContextMenu (slides) or DropdownMenu (stickies, docs, sheets, anchored
// floating menus). Both Radix families expose the same surface for our use, so
// passing the components in keeps the body identical.
export type CommentMenuPrimitives = {
    Item: ElementType;
    Sub: ElementType;
    SubTrigger: ElementType;
    SubContent: ElementType;
};

type CommentMenuItemsProps = {
    primitives: CommentMenuPrimitives;
    item: CommentMenuItem | null;
    // Noun in user-visible labels: "Edit {noun}", "{Noun} color", "Delete {noun}".
    // Defaults to "comment"; stickies passes "sticky".
    noun?: string;
    onAddComment?: () => void;
    onOpen?: (cardId: string) => void;
    onChangeColor?: (cardId: string, color: string) => void;
    onResolve?: (chatName: string) => void;
    onReopen?: (chatName: string) => void;
    onDelete?: (cardId: string) => void;
};

export function CommentMenuItems({
    primitives: { Item, Sub, SubTrigger, SubContent },
    item,
    noun = 'comment',
    onAddComment,
    onOpen,
    onChangeColor,
    onResolve,
    onReopen,
    onDelete,
}: CommentMenuItemsProps) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    if (!item) {
        if (!onAddComment) return null;
        return (
            <Item onClick={onAddComment}>
                <MessageSquarePlus className="h-4 w-4 mr-2" /> Add {noun}
            </Item>
        );
    }
    const { card, entry } = item;
    return (
        <>
            {onOpen && (
                <Item onClick={() => onOpen(card.id)}>
                    <Pencil className="h-4 w-4 mr-2" /> Edit {noun}
                </Item>
            )}
            {onChangeColor && (
                <Sub>
                    <SubTrigger className="gap-2">
                        <Palette className="h-4 w-4 mr-2" /> {Noun} color
                    </SubTrigger>
                    <SubContent>
                        <ColorSwatchRow
                            currentColor={card.color}
                            onChangeColor={(color) => onChangeColor(card.id, color)}
                        />
                    </SubContent>
                </Sub>
            )}
            {entry?.status === 'open' && onResolve && (
                <Item onClick={() => onResolve(entry.chatName)}>
                    <Check className="h-4 w-4 mr-2" /> Resolve {noun}
                </Item>
            )}
            {entry?.status === 'resolved' && onReopen && (
                <Item onClick={() => onReopen(entry.chatName)}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Reopen {noun}
                </Item>
            )}
            {onDelete && (
                <Item variant="destructive" onClick={() => onDelete(card.id)}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete {noun}
                </Item>
            )}
        </>
    );
}
