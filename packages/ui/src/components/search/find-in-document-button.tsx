import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Search } from 'lucide-react';
import { type RefObject, useRef } from 'react';
import { DropdownMenuItem } from '../dropdown-menu';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { useOptionalDocSearchBar } from './doc-search-provider';

// Toolbar ⌕ entry point for the find bar (mobile has no ⌘F). Null-safe: a toolbar rendered
// outside a DocSearchProvider shows no button.
export function FindInDocumentButton() {
    const docSearchBar = useOptionalDocSearchBar();
    if (!docSearchBar) return null;
    return (
        <TooltipButton
            icon={Search}
            tooltipText={`Find in document (${formatForDisplay('Mod+F')})`}
            onClick={docSearchBar.open}
        />
    );
}

// Kebab-menu counterpart of FindInDocumentButton, used by DocumentShareCluster on mobile.
// focusFindBarRef (from useFindBarRefocus) flags the pick so the menu's onCloseAutoFocus can
// re-focus the bar after Radix's exit steals focus back to the trigger.
export function FindInDocumentMenuItem({ focusFindBarRef }: { focusFindBarRef: RefObject<boolean> }) {
    const docSearchBar = useOptionalDocSearchBar();
    if (!docSearchBar) return null;
    return (
        <DropdownMenuItem
            onClick={() => {
                focusFindBarRef.current = true;
                docSearchBar.open();
            }}
        >
            <Search className="mr-2" />
            Find in document
        </DropdownMenuItem>
    );
}

// Radix keeps focus inside the closing menu until its exit finishes, so a focus set by a Find pick is
// stolen back to the trigger. A pick flags focusFindBarRef; onCloseAutoFocus then suppresses the
// trigger-restore AND re-opens the bar (open() re-focuses when already open). Shared by the doc + sheet
// Edit menus and the mobile kebab: spread onCloseAutoFocus onto the DropdownMenuContent, hand
// focusFindBarRef to the Find item(s).
export function useFindBarRefocus() {
    const docSearchBar = useOptionalDocSearchBar();
    const focusFindBarRef = useRef(false);
    const onCloseAutoFocus = (e: Event) => {
        if (!focusFindBarRef.current) return;
        focusFindBarRef.current = false;
        e.preventDefault();
        docSearchBar?.open();
    };
    return { docSearchBar, focusFindBarRef, onCloseAutoFocus };
}
