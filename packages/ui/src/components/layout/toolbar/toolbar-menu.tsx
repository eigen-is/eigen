import { Button } from '@workspace/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import type { ReactNode } from 'react';

type ToolbarMenuProps = {
    // The menubar entry label ("Insert" | "Format" | "Filter").
    label: string;
    // Width and pointer classes for the content; sheets pass `w-56 sheet-mousedown-cancel`.
    contentClassName?: string;
    // The DropdownMenuItem/Sub/Separator items, per-app.
    children: ReactNode;
    // Optional controlled open state (docs Insert, stickies Filter). Left uncontrolled when omitted.
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    // Pass-through for surfaces that re-focus a target after Radix's exit (EditMenu's find bar).
    onCloseAutoFocus?: (e: Event) => void;
};

// The generic 'ghost Button label + DropdownMenuContent align="start" + children' menubar entry,
// beside FileMenu/EditMenu. Owns only the trigger+content shell; the item list and the compact-fold
// gate stay caller-side (they differ per app), so this stays policy-free.
export function ToolbarMenu({
    label,
    contentClassName,
    children,
    open,
    onOpenChange,
    onCloseAutoFocus,
}: ToolbarMenuProps) {
    return (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                    {label}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={contentClassName} onCloseAutoFocus={onCloseAutoFocus}>
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
