// Draws one context menu at a point, for a host that holds its state in useContextMenu, such as a Drive listing, a
// chat or a canvas. The menu opens below a zero-size trigger at that point, keeps its keys and presses from the host
// underneath, and gives the focus back through restoreFocus as it closes.

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isKeyboardContextMenu } from './use-context-menu';

type ContextMenuAnchorProps = {
    contextMenu: {
        isOpen: boolean;
        position: { x: number; y: number };
        close: () => void;
        restoreFocus: () => void;
    };
    children: ReactNode;
    className?: string;
    // By default the focus goes back to what had it as the menu opened. A host that wants it elsewhere passes this,
    // calls event.preventDefault() and focuses its own target.
    onCloseAutoFocus?: (event: Event) => void;
};

export function ContextMenuAnchor({ contextMenu, children, className, onCloseAutoFocus }: ContextMenuAnchorProps) {
    return (
        <DropdownMenu open={contextMenu.isOpen} onOpenChange={(open) => !open && contextMenu.close()}>
            {/* In document.body, because a transformed ancestor, such as a dialog's translate, would become the containing block of these fixed coordinates. */}
            {createPortal(
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
                </DropdownMenuTrigger>,
                document.body,
            )}
            <DropdownMenuContent
                side="bottom"
                align="start"
                collisionPadding={8}
                className={className}
                // A Radix menu never stops its events, and portaled content still bubbles through the React tree.
                // Without these stops, a key or a click in the menu would reach the host underneath, such as a list's
                // keys or a grid's selection. A canvas host hit-tests on pointerdown and would clear the selection the
                // menu's rows act on. Only events inside the content stop, so Radix still closes on a press outside.
                onKeyDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                    e.stopPropagation();
                    // On Windows the menu key sends its contextmenu as the key comes up, when the menu the key opened
                    // holds the focus. Without this the browser's own menu would open over ours. A right-click in the
                    // menu still opens the browser's.
                    if (isKeyboardContextMenu(e.nativeEvent)) e.preventDefault();
                }}
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
