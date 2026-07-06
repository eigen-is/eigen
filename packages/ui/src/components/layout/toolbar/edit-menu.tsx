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
import { useRef } from 'react';
import { useOptionalDocSearchBar } from '../search/doc-search-provider';

type EditMenuProps = {
    // Gates the undo/redo section — pass the same condition the surface used for its icon
    // buttons (slides also excludes the sub-768px view-only band). Find stays available
    // regardless; "Find and replace" follows the bar context's canReplace.
    canEdit: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
};

// The 'Edit' menubar entry next to FileMenu, shared by all eigendoc toolbars. Undo machinery is
// per-app (Yjs UndoManager, TipTap history), so handlers come in as props; the find entries come
// from the DocSearchProvider the toolbar is mounted under (null-safe: absent provider → no items).
export function EditMenu({ canEdit, canUndo, canRedo, onUndo, onRedo }: EditMenuProps) {
    const docSearchBar = useOptionalDocSearchBar();
    // Radix keeps focus inside the closing menu until its exit finishes, so a focus set by the Find
    // handlers is stolen back mid-close. Flag a find pick so onCloseAutoFocus can suppress the
    // trigger-restore AND re-focus the (now open) bar after the close completes — open() re-focuses
    // when already open. Undo/Redo keep the default (they don't focus the bar).
    const focusFindBarRef = useRef(false);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost">Edit</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                onCloseAutoFocus={(e) => {
                    if (!focusFindBarRef.current) return;
                    focusFindBarRef.current = false;
                    e.preventDefault();
                    docSearchBar?.open();
                }}
            >
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
