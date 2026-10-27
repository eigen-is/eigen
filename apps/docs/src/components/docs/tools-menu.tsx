// The docs toolbar's Tools menu: Word count, and Show outline, which shows and hides the outline over the page's left
// side. Viewers get it too. A phone has no room for it, so the share cluster's kebab holds both rows there, and Show
// outline opens the outline's pane.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { ToolbarMenu } from '@workspace/ui';
import {
    DropdownMenuCheckboxItem,
    DropdownMenuItem,
    DropdownMenuShortcut,
} from '@workspace/ui/components/dropdown-menu';
import { TableOfContents, WholeWord } from 'lucide-react';

export const WORD_COUNT_HOTKEY = 'Mod+Shift+C';

export const WordCountItem = ({ onClick }: { onClick: () => void }) => (
    <DropdownMenuItem onClick={onClick}>
        <WholeWord className="h-4 w-4" /> Word count
        <DropdownMenuShortcut>{formatForDisplay(WORD_COUNT_HOTKEY)}</DropdownMenuShortcut>
    </DropdownMenuItem>
);

export const ShowOutlineItem = ({ onClick }: { onClick: () => void }) => (
    <DropdownMenuItem onClick={onClick}>
        <TableOfContents className="h-4 w-4" /> Show outline
    </DropdownMenuItem>
);

type ToolsMenuProps = {
    keepEditorFocus: (e: Event) => void;
    onWordCount: () => void;
    outlineShown: boolean;
    onToggleOutline: () => void;
};

export const ToolsMenu = ({ keepEditorFocus, onWordCount, outlineShown, onToggleOutline }: ToolsMenuProps) => (
    <ToolbarMenu label="Tools" onCloseAutoFocus={keepEditorFocus}>
        <WordCountItem onClick={onWordCount} />
        <DropdownMenuCheckboxItem checked={outlineShown} onCheckedChange={onToggleOutline}>
            Show outline
        </DropdownMenuCheckboxItem>
    </ToolbarMenu>
);
