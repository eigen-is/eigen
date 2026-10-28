// The entry points to the find bar outside its own keys: a toolbar button, a kebab-menu row, and the hook that
// gives the bar the focus back after a menu that opened it closes.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Search } from 'lucide-react';
import type { RefObject } from 'react';
import { useRef } from 'react';
import { DropdownMenuItem } from '../dropdown-menu';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { FIND_HOTKEY, useOptionalDocSearchBar } from './doc-search-provider';

// The toolbar's find button, which a phone needs as it has no ⌘F. A toolbar outside a DocSearchProvider shows none.
export function FindInDocumentButton() {
    const docSearchBar = useOptionalDocSearchBar();
    if (!docSearchBar) return null;
    return (
        <TooltipButton
            icon={Search}
            tooltipText={`Find in document (${formatForDisplay(FIND_HOTKEY)})`}
            onClick={docSearchBar.open}
        />
    );
}

// The find button's row in a phone's kebab menu. The pick sets focusFindBarRef from useFindBarRefocus, so the menu
// can give the bar the focus back once Radix has moved it to the trigger.
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
            <Search />
            Find in document
        </DropdownMenuItem>
    );
}

// Radix keeps the focus inside a closing menu until its exit finishes, and then gives it to the trigger, so a focus
// set by a Find pick is lost. A pick sets focusFindBarRef. The menu's onCloseAutoFocus then keeps the focus off the
// trigger and opens the bar again, which focuses its field when it is already open. A menu with a Find row, such
// as an Edit menu, passes onCloseAutoFocus to the menu and focusFindBarRef to its Find rows.
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
