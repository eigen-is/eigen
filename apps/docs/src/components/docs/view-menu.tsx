// The docs toolbar's View menu, which shows and hides the outline as Google's View › Show outline does, for viewers
// too. A phone has no room for it, so the share cluster's kebab holds Show outline there, which opens the outline's pane.

import { ToolbarMenu } from '@workspace/ui';
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { TableOfContents } from 'lucide-react';

export const ShowOutlineItem = ({ onClick }: { onClick: () => void }) => (
    <DropdownMenuItem onClick={onClick}>
        <TableOfContents className="h-4 w-4" /> Show outline
    </DropdownMenuItem>
);

type ViewMenuProps = {
    keepEditorFocus: (e: Event) => void;
    outlineShown: boolean;
    onToggleOutline: () => void;
};

export const ViewMenu = ({ keepEditorFocus, outlineShown, onToggleOutline }: ViewMenuProps) => (
    <ToolbarMenu label="View" onCloseAutoFocus={keepEditorFocus}>
        <DropdownMenuCheckboxItem checked={outlineShown} onCheckedChange={onToggleOutline}>
            Show outline
        </DropdownMenuCheckboxItem>
    </ToolbarMenu>
);
