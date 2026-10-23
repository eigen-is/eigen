import { formatForDisplay } from '@tanstack/react-hotkeys';
import { ToolbarMenu } from '@workspace/ui';
import { DropdownMenuItem, DropdownMenuShortcut } from '@workspace/ui/components/dropdown-menu';
import { WholeWord } from 'lucide-react';

export const WORD_COUNT_HOTKEY = 'Mod+Shift+C';

export const WordCountItem = ({ onClick }: { onClick: () => void }) => (
    <DropdownMenuItem onClick={onClick}>
        <WholeWord className="h-4 w-4" /> Word count
        <DropdownMenuShortcut>{formatForDisplay(WORD_COUNT_HOTKEY)}</DropdownMenuShortcut>
    </DropdownMenuItem>
);

type ToolsMenuProps = {
    keepEditorFocus: (e: Event) => void;
    onWordCount: () => void;
};

export const ToolsMenu = ({ keepEditorFocus, onWordCount }: ToolsMenuProps) => (
    <ToolbarMenu label="Tools" onCloseAutoFocus={keepEditorFocus}>
        <WordCountItem onClick={onWordCount} />
    </ToolbarMenu>
);
