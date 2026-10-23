// The object context menu, the singleton useContextMenu surface a right-click on a floating object opens. Composes
// the shared rows in MenuSections' order so every host's menu reads identically: the canvas wires them to its whole
// selection, a host with one object passes only what it has. A viewer's menu keeps only the rows that write nothing.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { ZOp } from '@workspace/lib/vector';
import { CopyPlus, Shapes, Trash2 } from 'lucide-react';
import { CommentMenuItems } from '../comments/comment-menu-items';
import { DropdownMenuItem } from '../dropdown-menu';
import { ContextMenuAnchor } from './context-menu-anchor';
import { MenuSections, type MenuSectionsProps } from './menu-sections';
import { ClipboardMenuItems, DownloadImageMenuItem, OrderMenuSub } from './object-menu-items';
import type { useContextMenu } from './use-context-menu';

type ObjectContextMenuProps<T> = {
    // The right-clicked object; the ops themselves act on whatever the host has selected.
    contextMenu: ReturnType<typeof useContextMenu<T>>;
    canEdit: boolean;
    // The right-clicked image's media file; undefined for any other object.
    imagePath: DrivePath | undefined;
    onArrange?: (op: ZOp) => void;
    onCut?: () => void;
    onCopy?: () => void;
    onPaste?: () => void;
    onDuplicate?: () => void;
    onDelete: () => void;
    // Replaces the selected chart with its shapes; omitted unless the selection is one chart that draws.
    onConvertToShapes?: () => void;
    // Raises a comment on the right-clicked object; omitted when the user can't comment.
    onComment?: () => void;
    // The host's own rows for this kind of object, each after the shared rows of its group; a viewer's too, so the
    // host leaves out what writes.
    hostSections?: Pick<MenuSectionsProps, 'create' | 'organize' | 'output'>;
};

export function ObjectContextMenu<T>({
    contextMenu,
    canEdit,
    imagePath,
    onArrange,
    onCut,
    onCopy,
    onPaste,
    onDuplicate,
    onDelete,
    onConvertToShapes,
    onComment,
    hostSections = {},
}: ObjectContextMenuProps<T>) {
    const output = (imagePath || hostSections.output) && (
        <>
            <DownloadImageMenuItem path={imagePath} />
            {hostSections.output}
        </>
    );
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {!canEdit && <MenuSections organize={hostSections.organize} output={output} />}
            {canEdit && contextMenu.isOpen && (
                <MenuSections
                    clipboard={
                        (onCut || onCopy || onPaste) && (
                            <ClipboardMenuItems onCut={onCut} onCopy={onCopy} onPaste={onPaste} />
                        )
                    }
                    create={
                        (onDuplicate || hostSections.create) && (
                            <>
                                {onDuplicate && (
                                    <DropdownMenuItem onClick={onDuplicate}>
                                        <CopyPlus className="h-4 w-4" /> Duplicate
                                    </DropdownMenuItem>
                                )}
                                {hostSections.create}
                            </>
                        )
                    }
                    organize={hostSections.organize}
                    arrange={onArrange && <OrderMenuSub onApply={onArrange} />}
                    convert={
                        onConvertToShapes && (
                            <DropdownMenuItem onClick={onConvertToShapes}>
                                <Shapes className="h-4 w-4" /> Convert to shapes
                            </DropdownMenuItem>
                        )
                    }
                    output={output}
                    // The shared "Add comment" row, so the label and icon match every other host; the card's own rows
                    // live in the comment panel, not on the canvas menu.
                    collaborate={onComment && <CommentMenuItems item={null} onAddComment={onComment} />}
                    destructive={
                        <DropdownMenuItem variant="destructive" onClick={onDelete}>
                            <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                    }
                />
            )}
        </ContextMenuAnchor>
    );
}
