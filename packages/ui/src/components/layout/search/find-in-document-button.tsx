import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Search } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { DropdownMenuItem } from '../../dropdown-menu';
import { TooltipButton } from '../toolbar/tooltip-button';
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
// focusFindBarRef flags the pick so the menu's onCloseAutoFocus can re-focus the bar after
// Radix's exit steals focus back to the trigger (same machinery as EditMenu's Find items).
export function FindInDocumentMenuItem({ focusFindBarRef }: { focusFindBarRef: MutableRefObject<boolean> }) {
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
