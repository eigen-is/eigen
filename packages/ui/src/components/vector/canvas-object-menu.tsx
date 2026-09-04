// The canvas object context menu — the singleton useContextMenu surface opened by a right-click on an
// element. Composes the same shared groups slides' menu uses (Arrange → Copy/Cut/Paste → Duplicate →
// Delete) so the two apps' menus read byte-identically. The ops act on the canvas' full selection,
// wired host-side to the clipboard producer/consumer, applyZOrder / duplicateElements / deleteElements.

import { CommentMenuItems } from '../comments';
import {
    ArrangeMenuItems,
    ClipboardMenuItems,
    ContextMenuAnchor,
    ObjectActionMenuItems,
    type useContextMenu,
} from '../context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../dropdown-menu';
import type { ZOp } from '../properties-panel/z-order';

type CanvasObjectMenuProps = {
    // The item is the right-clicked element id; the ops themselves read the canvas' selection.
    contextMenu: ReturnType<typeof useContextMenu<string>>;
    onArrange: (op: ZOp) => void;
    onCopy: () => void;
    onCut: () => void;
    onPaste: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    // Raises a comment on the right-clicked element; omitted when the user can't comment.
    onComment?: () => void;
};

export function CanvasObjectMenu({
    contextMenu,
    onArrange,
    onCopy,
    onCut,
    onPaste,
    onDuplicate,
    onDelete,
    onComment,
}: CanvasObjectMenuProps) {
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {contextMenu.item && (
                <>
                    <ArrangeMenuItems onApply={onArrange} />
                    <DropdownMenuSeparator />
                    <ClipboardMenuItems onCopy={onCopy} onCut={onCut} onPaste={onPaste} />
                    <DropdownMenuSeparator />
                    <ObjectActionMenuItems onDuplicate={onDuplicate} onDelete={onDelete} />
                    {onComment && (
                        <>
                            <DropdownMenuSeparator />
                            {/* The shared "Add comment" row, so the label + icon match every other host;
                                the card's own rows live in the comment panel, not on the canvas menu. */}
                            <CommentMenuItems
                                primitives={{
                                    Item: DropdownMenuItem,
                                    Sub: DropdownMenuSub,
                                    SubTrigger: DropdownMenuSubTrigger,
                                    SubContent: DropdownMenuSubContent,
                                }}
                                item={null}
                                onAddComment={onComment}
                            />
                        </>
                    )}
                </>
            )}
        </ContextMenuAnchor>
    );
}
