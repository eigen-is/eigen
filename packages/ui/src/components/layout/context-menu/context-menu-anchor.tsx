import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import type { ReactNode } from 'react';

type ContextMenuAnchorProps = {
    contextMenu: { isOpen: boolean; position: { x: number; y: number }; close: () => void };
    children: ReactNode;
    className?: string;
    // The trigger is a 0×0 pointer-events:none div, so Radix's default close
    // behaviour (focus the trigger) silently drops focus to <body>. Pass this to
    // preventDefault and move focus somewhere useful (e.g. a host's own input) so
    // keyboard handling keeps working after the menu closes.
    onCloseAutoFocus?: (event: Event) => void;
};

export function ContextMenuAnchor({ contextMenu, children, className, onCloseAutoFocus }: ContextMenuAnchorProps) {
    return (
        <DropdownMenu open={contextMenu.isOpen} onOpenChange={(open) => !open && contextMenu.close()}>
            <DropdownMenuTrigger asChild>
                <div
                    style={{
                        position: 'fixed',
                        left: contextMenu.position.x,
                        top: contextMenu.position.y,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                    }}
                />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                side="bottom"
                align="start"
                collisionPadding={8}
                className={className}
                onCloseAutoFocus={onCloseAutoFocus}
            >
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
