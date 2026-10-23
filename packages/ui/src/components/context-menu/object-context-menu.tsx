// The object context menu, the singleton useContextMenu surface a right-click on a floating object opens.
// Composes the shared groups (Arrange → Copy/Cut/Paste → Duplicate → Delete) so every host's menu reads
// identically: the canvas wires them to its whole selection, Sheets to its one object, which has no paste
// or duplicate. A host's own rows follow the object actions. A viewer's menu keeps only the download rows.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { ZOp } from '@workspace/lib/vector';
import { Shapes } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommentMenuItems } from '../comments/comment-menu-items';
import { DropdownMenuItem, DropdownMenuSeparator } from '../dropdown-menu';
import { ContextMenuAnchor } from './context-menu-anchor';
import {
    ArrangeMenuItems,
    ClipboardMenuItems,
    DownloadImageMenuItem,
    ObjectActionMenuItems,
} from './object-menu-items';
import type { useContextMenu } from './use-context-menu';

type ObjectContextMenuProps<T> = {
    // The right-clicked object; the ops themselves act on whatever the host has selected.
    contextMenu: ReturnType<typeof useContextMenu<T>>;
    canEdit: boolean;
    // The right-clicked image's media file; undefined for any other object.
    imagePath: DrivePath | undefined;
    onArrange: (op: ZOp) => void;
    onCopy?: () => void;
    onCut?: () => void;
    onPaste?: () => void;
    onDuplicate?: () => void;
    onDelete: () => void;
    // Replaces the selected chart with its shapes; omitted unless the selection is one chart that draws.
    onConvertToShapes?: () => void;
    // Raises a comment on the right-clicked object; omitted when the user can't comment.
    onComment?: () => void;
    // The host's own rows for this kind of object, a viewer's too, so the host leaves out what writes.
    children?: ReactNode;
};

export function ObjectContextMenu<T>({
    contextMenu,
    canEdit,
    imagePath,
    onArrange,
    onCopy,
    onCut,
    onPaste,
    onDuplicate,
    onDelete,
    onConvertToShapes,
    onComment,
    children,
}: ObjectContextMenuProps<T>) {
    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {!canEdit && (
                <>
                    <DownloadImageMenuItem path={imagePath} />
                    {children}
                </>
            )}
            {canEdit && contextMenu.isOpen && (
                <>
                    <ArrangeMenuItems onApply={onArrange} />
                    <DropdownMenuSeparator />
                    {(onCopy || onCut || onPaste) && (
                        <>
                            <ClipboardMenuItems onCopy={onCopy} onCut={onCut} onPaste={onPaste} />
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <ObjectActionMenuItems onDuplicate={onDuplicate} onDelete={onDelete} />
                    {onConvertToShapes && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={onConvertToShapes}>
                                <Shapes className="h-4 w-4 mr-2" /> Convert to shapes
                            </DropdownMenuItem>
                        </>
                    )}
                    {children && (
                        <>
                            <DropdownMenuSeparator />
                            {children}
                        </>
                    )}
                    {imagePath && (
                        <>
                            <DropdownMenuSeparator />
                            <DownloadImageMenuItem path={imagePath} />
                        </>
                    )}
                    {onComment && (
                        <>
                            <DropdownMenuSeparator />
                            {/* The shared "Add comment" row, so the label + icon match every other host;
                                the card's own rows live in the comment panel, not on the canvas menu. */}
                            <CommentMenuItems item={null} onAddComment={onComment} />
                        </>
                    )}
                </>
            )}
        </ContextMenuAnchor>
    );
}
