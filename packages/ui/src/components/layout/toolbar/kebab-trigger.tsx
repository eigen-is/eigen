// The ⋮ that opens a toolbar's overflow menu, flat like every icon-only button. It goes inside a DropdownMenu.

import { MoreVertical } from 'lucide-react';
import { Button } from '../../button';
import { DropdownMenuTrigger } from '../../dropdown-menu';

export function KebabTrigger({ title = 'More actions' }: { title?: string }) {
    return (
        <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" title={title} aria-label={title}>
                <MoreVertical className="h-4 w-4" />
            </Button>
        </DropdownMenuTrigger>
    );
}
