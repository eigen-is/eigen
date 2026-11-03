// The ⋮ button on a list row or a tile that opens the row's context menu below it, where a right-click opens it under
// the pointer. Its caller passes what opens the menu, such as useSelectableContextMenu's openFromButton for its row,
// and its own size and reveal classes. The click stops at the button, so the row under it doesn't select or open.
// Tab skips it: its row sits in a list with keyboard navigation, whose menu key opens the same menu, so a row's
// buttons don't each cost a Tab stop.

import { MoreVertical } from 'lucide-react';
import { cn } from '../../lib/utils';

type ContextMenuButtonProps = {
    onOpen: (button: HTMLElement) => void;
    className?: string;
};

export function ContextMenuButton({ onOpen, className }: ContextMenuButtonProps) {
    return (
        <button
            type="button"
            aria-label="More actions"
            tabIndex={-1}
            onClick={(e) => {
                e.stopPropagation();
                onOpen(e.currentTarget);
            }}
            className={cn('flex items-center justify-center rounded text-muted-foreground hover:bg-accent', className)}
        >
            <MoreVertical className="h-4 w-4" />
        </button>
    );
}
