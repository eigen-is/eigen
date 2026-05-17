import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { Check, MessageSquare, MessageSquarePlus, Palette, RotateCcw, Trash2 } from 'lucide-react';
import type { ElementType } from 'react';
import { ColorSwatchRow } from '../notes/color-swatch-row';

export type CommentMenuItem = { card: CommentCard; entry: CommentEntry | undefined };

// Slot for the menu primitives so the same items can render inside either a
// Radix ContextMenu (slides) or DropdownMenu (sheets, stickies). Both Radix
// families expose the same surface for our use, so passing the components in
// keeps the body identical.
export type CommentMenuPrimitives = {
    Item: ElementType;
    Sub: ElementType;
    SubTrigger: ElementType;
    SubContent: ElementType;
};

type CommentMenuItemsProps = {
    primitives: CommentMenuPrimitives;
    item: CommentMenuItem | null;
    onAddComment?: () => void;
    onView?: (cardId: string) => void;
    onChangeColor?: (cardId: string, color: string) => void;
    onResolve?: (chatName: string) => void;
    onReopen?: (chatName: string) => void;
    onDelete?: (cardId: string) => void;
};

export function CommentMenuItems({
    primitives: { Item, Sub, SubTrigger, SubContent },
    item,
    onAddComment,
    onView,
    onChangeColor,
    onResolve,
    onReopen,
    onDelete,
}: CommentMenuItemsProps) {
    if (!item) {
        if (!onAddComment) return null;
        return (
            <Item onClick={onAddComment}>
                <MessageSquarePlus className="h-4 w-4 mr-2" /> Add comment
            </Item>
        );
    }
    const { card, entry } = item;
    return (
        <>
            {onView && (
                <Item onClick={() => onView(card.id)}>
                    <MessageSquare className="h-4 w-4 mr-2" /> View comment
                </Item>
            )}
            {onChangeColor && (
                <Sub>
                    <SubTrigger className="gap-2">
                        <Palette className="h-4 w-4 mr-2" /> Comment color
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
                    <Check className="h-4 w-4 mr-2" /> Resolve comment
                </Item>
            )}
            {entry?.status === 'resolved' && onReopen && (
                <Item onClick={() => onReopen(entry.chatName)}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Reopen comment
                </Item>
            )}
            {onDelete && (
                <Item variant="destructive" onClick={() => onDelete(card.id)}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete comment
                </Item>
            )}
        </>
    );
}
