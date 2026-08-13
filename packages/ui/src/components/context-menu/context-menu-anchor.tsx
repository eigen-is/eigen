import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import type { ReactNode } from 'react';

type ContextMenuAnchorProps = {
    contextMenu: {
        isOpen: boolean;
        position: { x: number; y: number };
        close: () => void;
        restoreFocus: () => void;
    };
    children: ReactNode;
    className?: string;
    // By default the anchor restores focus to the element that was focused when
    // the menu opened (see useContextMenu). Pass this to send focus somewhere
    // else instead — call event.preventDefault() and focus your own target.
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
                // Radix menus never stop propagation, and portaled content still
                // bubbles through the React tree — without these stops, menu-internal
                // keystrokes and clicks reach the host surface underneath (list
                // keyboard navigation, grid selection handlers).
                onKeyDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
                onCloseAutoFocus={(e) => {
                    if (onCloseAutoFocus) {
                        onCloseAutoFocus(e);
                        return;
                    }
                    e.preventDefault();
                    contextMenu.restoreFocus();
                }}
            >
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
