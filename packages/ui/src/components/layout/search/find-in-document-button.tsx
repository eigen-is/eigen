import { formatForDisplay } from '@tanstack/react-hotkeys';
import { Search } from 'lucide-react';
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
