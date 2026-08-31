import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Redo, Search, TextSearch, Undo } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFindBarRefocus } from '../../search/find-in-document-button';

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
};

// The 'Edit' menubar entry next to FileMenu, shared by all eigendoc toolbars. Undo machinery is
// per-app (Yjs UndoManager, TipTap history), so handlers come in as props; the find entries come
// from the DocSearchProvider the toolbar is mounted under (null-safe: absent provider → no items).
export function EditMenu({ canEdit, canUndo, canRedo, onUndo, onRedo, children }: EditMenuProps) {
    const { docSearchBar, focusFindBarRef, onCloseAutoFocus } = useFindBarRefocus();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost">Edit</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={onCloseAutoFocus}>
                {canEdit && (
                    <>
                        <DropdownMenuItem onClick={onUndo} disabled={!canUndo}>
                            <Undo className="h-4 w-4 mr-2" /> Undo
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Z')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onRedo} disabled={!canRedo}>
                            <Redo className="h-4 w-4 mr-2" /> Redo
                            <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+Z')}</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        {children}
                        {docSearchBar && <DropdownMenuSeparator />}
                    </>
                )}
                {docSearchBar && (
                    <DropdownMenuItem
                        onClick={() => {
                            focusFindBarRef.current = true;
                            docSearchBar.open();
                        }}
                    >
                        <Search className="h-4 w-4 mr-2" /> Find
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
                        <TextSearch className="h-4 w-4 mr-2" /> Find and replace
                        <DropdownMenuShortcut>{formatForDisplay('Mod+Alt+F')}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
