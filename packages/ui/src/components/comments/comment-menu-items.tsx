import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, MessageSquare, MessageSquarePlus, Palette, RotateCcw, Trash2 } from 'lucide-react';
import type { ElementType } from 'react';
import { AssigneeMenuItems } from './assignee-menu-items';

export type CommentContextMenuItem = { card: CommentCard; entry: CommentEntry | undefined };

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
    item: CommentContextMenuItem | null;
    // Noun in user-visible labels: "Edit {noun}", "{Noun} color", "Delete {noun}".
    // Defaults to "comment"; stickies passes "sticky".
    noun?: string;
    onAddComment?: () => void;
    onOpen?: (cardId: string) => void;
    onChangeColor?: (cardId: string, color: string) => void;
    onResolve?: (chatName: string, title?: string) => void;
    onReopen?: (chatName: string, title?: string) => void;
    onDelete?: (cardId: string) => void;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onAssign?: (chatName: string, email: string | null, title?: string) => void;
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
    members,
    currentUserEmail,
    onAssign,
}: CommentMenuItemsProps) {
    const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    if (!item) {
        if (!onAddComment) return null;
        return (
            <Item onClick={onAddComment}>
                <MessageSquarePlus className="h-4 w-4" /> Add {noun}
            </Item>
        );
    }
    const { card, entry } = item;
    return (
        <>
            {onOpen && (
                <Item onClick={() => onOpen(card.id)}>
                    <MessageSquare className="h-4 w-4" /> View {noun}
                </Item>
            )}
            {onChangeColor && (
                <Sub>
                    <SubTrigger className="gap-2">
                        <Palette className="h-4 w-4" /> {Noun} color
                    </SubTrigger>
                    <SubContent>
                        {EIGEN_STICKIES_COLORS[0].map((c) => (
                            <Item key={c.value} onClick={() => onChangeColor(card.id, c.value)}>
                                <span
                                    className="h-4 w-4 shrink-0 rounded-full border border-border/50"
                                    style={{ backgroundColor: c.value }}
                                />
                                <span className="flex-1">{c.label}</span>
                                {card.color === c.value && <Check className="h-4 w-4 shrink-0" />}
                            </Item>
                        ))}
                    </SubContent>
                </Sub>
            )}
            {onAssign && members && currentUserEmail && entry && (
                <AssigneeMenuItems
                    primitives={{ Item, Sub, SubTrigger, SubContent }}
                    members={members}
                    currentUserEmail={currentUserEmail}
                    assignee={entry.assignee}
                    onAssign={(email) => onAssign(entry.chatName, email, card.title)}
                />
            )}
            {entry?.status === 'open' && onResolve && (
                <Item onClick={() => onResolve(entry.chatName, card.title)}>
                    <Check className="h-4 w-4" /> Resolve {noun}
                </Item>
            )}
            {entry?.status === 'resolved' && onReopen && (
                <Item onClick={() => onReopen(entry.chatName, card.title)}>
                    <RotateCcw className="h-4 w-4" /> Reopen {noun}
                </Item>
            )}
            {onDelete && (
                <Item variant="destructive" onClick={() => onDelete(card.id)}>
                    <Trash2 className="h-4 w-4" /> Delete {noun}
                </Item>
            )}
        </>
    );
}
