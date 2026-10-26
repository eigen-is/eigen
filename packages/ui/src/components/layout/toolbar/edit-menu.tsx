import { formatForDisplay } from '@tanstack/react-hotkeys';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@workspace/ui/components/dropdown-menu';
import { Redo, Search, TextSearch, Undo } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFindBarRefocus } from '../../search/find-in-document-button';
import { ToolbarMenu } from './toolbar-menu';

type EditMenuProps = {
    // Gates the undo/redo section — pass the same condition the surface used for its icon
    // buttons (slides also excludes the sub-768px view-only band). Find stays available
    // regardless; "Find and replace" follows the bar context's canReplace.
    canEdit: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    // Host-app edit entries (vector's tool-lock toggle), rendered after Undo/Redo when canEdit.
    children?: ReactNode;
    // Host-app selection entries (docs' Cut, Copy, Select all, Delete), a group of their own between Undo and Find, for
    // viewers too: the host gates each entry.
    selectionItems?: ReactNode;
    // An editor that takes focus back on Undo or Redo passes its keep-focus handler; a Find pick still focuses the bar.
    onCloseAutoFocus?: (event: Event) => void;
};

// The 'Edit' menubar entry next to FileMenu, shared by all eigendoc toolbars. Undo machinery is
// per-app (Yjs UndoManager, TipTap history), so handlers come in as props; the find entries come
// from the DocSearchProvider the toolbar is mounted under (null-safe: absent provider → no items).
export function EditMenu({
    canEdit,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    children,
    selectionItems,
    onCloseAutoFocus,
}: EditMenuProps) {
    const { docSearchBar, focusFindBarRef, onCloseAutoFocus: refocusFindBar } = useFindBarRefocus();

    return (
        <ToolbarMenu
            label="Edit"
            onCloseAutoFocus={(event) => {
                refocusFindBar(event);
                if (!event.defaultPrevented) onCloseAutoFocus?.(event);
            }}
        >
            {canEdit && (
                <>
                    <DropdownMenuItem onClick={onUndo} disabled={!canUndo}>
                        <Undo className="h-4 w-4" /> Undo
                        <DropdownMenuShortcut>{formatForDisplay('Mod+Z')}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onRedo} disabled={!canRedo}>
                        <Redo className="h-4 w-4" /> Redo
                        <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+Z')}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    {children}
                </>
            )}
            <DropdownMenuSeparator />
            {selectionItems}
            <DropdownMenuSeparator />
            {docSearchBar && (
                <DropdownMenuItem
                    onClick={() => {
                        focusFindBarRef.current = true;
                        docSearchBar.open();
                    }}
                >
                    <Search className="h-4 w-4" /> Find
                    <DropdownMenuShortcut>{formatForDisplay('Mod+F')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
            {docSearchBar?.canReplace && (
                <DropdownMenuItem
                    onClick={() => {
                        focusFindBarRef.current = true;
                        docSearchBar.openReplace();
                    }}
                >
                    <TextSearch className="h-4 w-4" /> Find and replace
                    <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+H')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
        </ToolbarMenu>
    );
}
