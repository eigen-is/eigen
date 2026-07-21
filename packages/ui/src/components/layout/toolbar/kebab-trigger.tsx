import { MoreVertical } from 'lucide-react';
import { Button } from '../../button';
import { DropdownMenuTrigger } from '../../dropdown-menu';

// Shared ⋮ trigger for toolbar overflow menus — compose inside a DropdownMenu.
export function KebabTrigger({
    title = 'More actions',
    variant = 'ghost',
}: {
    title?: string;
    variant?: 'ghost' | 'outline';
}) {
    return (
        <DropdownMenuTrigger asChild>
            <Button variant={variant} size="icon" className="h-8 w-8" title={title} aria-label={title}>
                <MoreVertical className="h-4 w-4" />
            </Button>
        </DropdownMenuTrigger>
    );
}
