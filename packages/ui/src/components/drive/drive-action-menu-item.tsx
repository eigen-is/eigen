// One Drive action drawn as a menu row, such as Rename or Move to trash: its icon, its label counted for a
// multi-selection, red when it destroys, and the key that runs it where the host binds one. Menus that offer
// Drive actions draw their rows through it, for example the Drive item menu and an open document's File menu.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { labelFor } from '@workspace/lib/drive';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import { DropdownMenuItem, DropdownMenuShortcut } from '../dropdown-menu';

type DriveActionMenuItemProps = {
    action: PaletteSelectionAction['action'];
    // How many items the row acts on, which picks its plural label.
    count: number;
    // The hotkey that runs the row, shown only where the host binds it.
    shortcut?: string;
    onClick: () => void;
};

export function DriveActionMenuItem({ action, count, shortcut, onClick }: DriveActionMenuItemProps) {
    return (
        <DropdownMenuItem variant={action.group === 'destructive' ? 'destructive' : 'default'} onClick={onClick}>
            <action.icon className="h-4 w-4" />
            {labelFor(action, count)}
            {shortcut && <DropdownMenuShortcut>{formatForDisplay(shortcut)}</DropdownMenuShortcut>}
        </DropdownMenuItem>
    );
}
