import type { useCommentLifecycle } from '@workspace/lib/comments';
import { type CommentContextMenuItem, CommentLifecycleMenuItems } from '@workspace/ui/components/comments';
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
    lifecycle: ReturnType<typeof useCommentLifecycle>,
): CommentContextMenuItem[] {
    const items: CommentContextMenuItem[] = [];
    for (const cardId of obj.commentCardIds ?? []) {
        const card = lifecycle.cards[cardId];
        if (!card) continue;
        const entry = card.chatName ? lifecycle.allComments.find((e) => e.chatName === card.chatName) : undefined;
        items.push({ card, entry });
    }
    return items;
}

type SlideObjectMenuProps = {
    contextMenu: ReturnType<typeof useContextMenu<SlideObject>>;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    canWrite: boolean;
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
    onCommentDelete?: (objId: string, cardId: string) => void;
};

export function SlideObjectMenu({
    contextMenu,
    lifecycle,
    canWrite,
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
    onCommentDelete,
}: SlideObjectMenuProps) {
    const obj = contextMenu.item;
    const commentItems = obj ? getCommentItems(obj, lifecycle) : [];
    const single = commentItems.length === 1 ? commentItems[0] : null;
    const showAdd = !!onAddComment && commentItems.length === 0;

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
                            <CommentLifecycleMenuItems
                                lifecycle={lifecycle}
                                primitives={{
                                    Item: DropdownMenuItem,
                                    Sub: DropdownMenuSub,
                                    SubTrigger: DropdownMenuSubTrigger,
                                    SubContent: DropdownMenuSubContent,
                                }}
                                item={single}
                                canWrite={canWrite}
                                onAddComment={onAddComment ? () => onAddComment(obj.id) : undefined}
                                onDelete={onCommentDelete ? (cardId) => onCommentDelete(obj.id, cardId) : undefined}
                            />
                        </>
                    )}
                </>
            )}
        </ContextMenuAnchor>
    );
}
