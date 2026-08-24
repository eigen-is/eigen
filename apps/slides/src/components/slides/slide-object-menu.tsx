import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { type CommentContextMenuItem, CommentMenuItems } from '@workspace/ui/components/comments';
import { ContextMenuAnchor, type useContextMenu } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Copy, Trash2 } from 'lucide-react';
import type { SlideObject } from './types';

export function getCommentItems(
    obj: SlideObject,
    cards: Record<string, CommentCard> | undefined,
    entries: CommentEntry[] | undefined,
): CommentContextMenuItem[] {
    const items: CommentContextMenuItem[] = [];
    for (const cardId of obj.commentCardIds ?? []) {
        const card = cards?.[cardId];
        if (!card) continue;
        const entry = card.chatName ? entries?.find((e) => e.chatName === card.chatName) : undefined;
        items.push({ card, entry });
    }
    return items;
}

type SlideObjectMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<SlideObject>>;
    cards?: Record<string, CommentCard>;
    entries?: CommentEntry[];
    onCopy?: (objId: string) => void;
    onDelete?: (objId: string) => void;
    onMoveUp?: (objId: string) => void;
    onMoveDown?: (objId: string) => void;
    onMoveToFront?: (objId: string) => void;
    onMoveToBack?: (objId: string) => void;
    onAddComment?: (objId: string) => void;
    onCommentClick?: (cardId: string) => void;
    onCommentChangeColor?: (cardId: string, color: string) => void;
    onCommentResolve?: (chatName: string, title?: string) => void;
    onCommentReopen?: (chatName: string, title?: string) => void;
    onCommentDelete?: (objId: string, cardId: string) => void;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    onCommentAssign?: (chatName: string, email: string | null, title?: string) => void;
};

export function SlideObjectMenu({
    contextMenu,
    cards,
    entries,
    onCopy,
    onDelete,
    onMoveUp,
    onMoveDown,
    onMoveToFront,
    onMoveToBack,
    onAddComment,
    onCommentClick,
    onCommentChangeColor,
    onCommentResolve,
    onCommentReopen,
    onCommentDelete,
    members,
    currentUserEmail,
    onCommentAssign,
}: SlideObjectMenuProps) {
    const obj = contextMenu.item;
    const commentItems = obj ? getCommentItems(obj, cards, entries) : [];
    const single = commentItems.length === 1 ? commentItems[0] : null;
    const showAdd = !!onAddComment && commentItems.length === 0;

    // Color swatches are plain buttons, not menu items, so they don't auto-close the menu.
    const handleChangeColor = (cardId: string, color: string) => {
        onCommentChangeColor?.(cardId, color);
        contextMenu.close();
    };

    // Assignee rows are plain buttons inside the sub-content, so they don't auto-close either.
    const handleAssign = (chatName: string, email: string | null, title?: string) => {
        onCommentAssign?.(chatName, email, title);
        contextMenu.close();
    };

    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {obj && (
                <>
                    <DropdownMenuItem onClick={() => onCopy?.(obj.id)}>
                        <Copy className="h-4 w-4 mr-2" /> Copy
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {/* Z-order — shares the ZOrderButtons vocabulary/order (front at top). */}
                    <DropdownMenuItem onClick={() => onMoveToFront?.(obj.id)}>
                        <ArrowUpToLine className="h-4 w-4 mr-2" /> Bring to front
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMoveUp?.(obj.id)}>
                        <ChevronUp className="h-4 w-4 mr-2" /> Bring forward
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMoveDown?.(obj.id)}>
                        <ChevronDown className="h-4 w-4 mr-2" /> Send backward
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMoveToBack?.(obj.id)}>
                        <ArrowDownToLine className="h-4 w-4 mr-2" /> Send to back
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete?.(obj.id)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                    </DropdownMenuItem>
                    {(single || showAdd) && (
                        <>
                            <DropdownMenuSeparator />
                            <CommentMenuItems
                                primitives={{
                                    Item: DropdownMenuItem,
                                    Sub: DropdownMenuSub,
                                    SubTrigger: DropdownMenuSubTrigger,
                                    SubContent: DropdownMenuSubContent,
                                }}
                                item={single}
                                onAddComment={onAddComment ? () => onAddComment(obj.id) : undefined}
                                onOpen={onCommentClick}
                                onChangeColor={onCommentChangeColor ? handleChangeColor : undefined}
                                onResolve={onCommentResolve}
                                onReopen={onCommentReopen}
                                onDelete={onCommentDelete ? (cardId) => onCommentDelete(obj.id, cardId) : undefined}
                                members={members}
                                currentUserEmail={currentUserEmail}
                                onAssign={onCommentAssign ? handleAssign : undefined}
                            />
                        </>
                    )}
                </>
            )}
        </ContextMenuAnchor>
    );
}
