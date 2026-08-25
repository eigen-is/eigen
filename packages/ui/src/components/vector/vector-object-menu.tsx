// The vector object context menu — the singleton useContextMenu surface opened by a right-click on an
// element. Composes the same shared groups slides' menu uses (Arrange → Copy/Cut/Paste → Duplicate →
// Delete) so the two apps' menus read byte-identically. The ops act on the canvas' full selection,
// wired host-side to the clipboard producer/consumer, applyZOrder / duplicateElements / deleteElements.

import {
    ArrangeMenuItems,
    ClipboardMenuItems,
    ContextMenuAnchor,
    ObjectActionMenuItems,
    type useContextMenu,
} from '../context-menu';
import { DropdownMenuSeparator } from '../dropdown-menu';
import type { ZOp } from '../properties-panel/z-order';

type VectorObjectMenuProps = {
    // The item is the right-clicked element id; the ops themselves read the canvas' selection.
    contextMenu: ReturnType<typeof useContextMenu<string>>;
    onArrange: (op: ZOp) => void;
    onCopy: () => void;
    onCut: () => void;
    onPaste: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
};

export function VectorObjectMenu({
    contextMenu,
    onArrange,
    onCopy,
    onCut,
    onPaste,
    onDuplicate,
    onDelete,
}: VectorObjectMenuProps) {
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {contextMenu.item && (
                <>
                    <ArrangeMenuItems onApply={onArrange} />
                    <DropdownMenuSeparator />
                    <ClipboardMenuItems onCopy={onCopy} onCut={onCut} onPaste={onPaste} />
                    <DropdownMenuSeparator />
                    <ObjectActionMenuItems onDuplicate={onDuplicate} onDelete={onDelete} />
                </>
            )}
        </ContextMenuAnchor>
    );
}
