import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { type CommentContextMenuItem, CommentMenuItems } from '@workspace/ui/components/comments';
import {
    ArrangeMenuItems,
    ClipboardMenuItems,
    ContextMenuAnchor,
    ObjectActionMenuItems,
    type useContextMenu,
} from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import type { ZOp } from '@workspace/ui/components/properties-panel';
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
    onCut?: (objId: string) => void;
    onPaste?: () => void;
    onDuplicate?: (objId: string) => void;
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
    onCut,
    onPaste,
    onDuplicate,
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

    // The four z-order callbacks map onto the shared Arrange group's single ZOp verb — keeping
    // SlideObjectMenu's prop surface unchanged so slide-canvas' wiring stays byte-for-byte the same.
    const onArrange = (op: ZOp) => {
        if (!obj) return;
        if (op === 'toFront') onMoveToFront?.(obj.id);
        else if (op === 'forward') onMoveUp?.(obj.id);
        else if (op === 'backward') onMoveDown?.(obj.id);
        else onMoveToBack?.(obj.id);
    };

    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {obj && (
                <>
                    <ClipboardMenuItems
                        onCopy={onCopy ? () => onCopy(obj.id) : undefined}
                        onCut={onCut ? () => onCut(obj.id) : undefined}
                        onPaste={onPaste}
                    />
                    <DropdownMenuSeparator />
                    <ArrangeMenuItems onApply={onArrange} />
                    <DropdownMenuSeparator />
                    <ObjectActionMenuItems
                        onDuplicate={onDuplicate ? () => onDuplicate(obj.id) : undefined}
                        onDelete={() => onDelete?.(obj.id)}
                    />
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
