// The vector object context menu — the singleton useContextMenu surface opened by a right-click on an
// element. Composes the same shared groups slides' menu uses (Arrange → Duplicate → Delete) so the
// two apps' menus read byte-identically; vector has no clipboard row yet (U5b adds Copy/Cut/Paste).
// The ops act on the canvas' full selection, wired host-side to applyZOrder / duplicateElements /
// deleteElements.

import { ArrangeMenuItems, ContextMenuAnchor, ObjectActionMenuItems, type useContextMenu } from '../context-menu';
import { DropdownMenuSeparator } from '../dropdown-menu';
import type { ZOp } from '../properties-panel/z-order';

type VectorObjectMenuProps = {
    // The item is the right-clicked element id; the ops themselves read the canvas' selection.
    contextMenu: ReturnType<typeof useContextMenu<string>>;
    onArrange: (op: ZOp) => void;
    onDuplicate: () => void;
    onDelete: () => void;
};

export function VectorObjectMenu({ contextMenu, onArrange, onDuplicate, onDelete }: VectorObjectMenuProps) {
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {contextMenu.item && (
                <>
                    <ArrangeMenuItems onApply={onArrange} />
                    <DropdownMenuSeparator />
                    <ObjectActionMenuItems onDuplicate={onDuplicate} onDelete={onDelete} />
                </>
            )}
        </ContextMenuAnchor>
    );
}
