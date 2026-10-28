// The Edit menu of a document app's bar, such as Docs' or Stickies': Undo and Redo, a host's own entries such as
// Cut and Copy, and Find. Each app has its own undo machinery, such as a Yjs UndoManager or Tiptap's history, so
// the handlers come in as props. The Find entries come from the DocSearchProvider the bar sits under, and a Find
// pick hands the focus to the find bar rather than to the host's editor.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { REDO_HOTKEY, UNDO_HOTKEY } from '@workspace/lib/constants/hotkeys';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@workspace/ui/components/dropdown-menu';
import { Redo, Search, TextSearch, Undo } from 'lucide-react';
import type { ReactNode } from 'react';
import { FIND_HOTKEY, FIND_REPLACE_HOTKEY } from '../../search/doc-search-provider';
import { useFindBarRefocus } from '../../search/find-in-document-button';
import { AppBarMenu } from './app-bar-menu';

type EditMenuProps = {
    // Whether the Undo and Redo rows show. Pass the condition the surface uses for its own undo buttons,
    // such as Slides', which also leaves out the narrow view-only layout. Find shows either way, and
    // Find and replace follows the bar context's canReplace.
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
        <AppBarMenu
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
                        <DropdownMenuShortcut>{formatForDisplay(UNDO_HOTKEY)}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onRedo} disabled={!canRedo}>
                        <Redo className="h-4 w-4" /> Redo
                        <DropdownMenuShortcut>{formatForDisplay(REDO_HOTKEY)}</DropdownMenuShortcut>
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
                    <DropdownMenuShortcut>{formatForDisplay(FIND_HOTKEY)}</DropdownMenuShortcut>
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
                    <DropdownMenuShortcut>{formatForDisplay(FIND_REPLACE_HOTKEY)}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
        </AppBarMenu>
    );
}
