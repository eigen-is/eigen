import {DropdownMenu, DropdownMenuContent, DropdownMenuTrigger} from '@workspace/ui/components/dropdown-menu';
import type {ReactNode} from 'react';

type ContextMenuAnchorProps = {
    contextMenu: { isOpen: boolean; position: { x: number; y: number }; close: () => void };
    children: ReactNode;
    className?: string;
};

export function ContextMenuAnchor({contextMenu, children, className}: ContextMenuAnchorProps) {
    return (
        <DropdownMenu open={contextMenu.isOpen} onOpenChange={(open) => !open && contextMenu.close()}>
            <DropdownMenuTrigger className="hidden"/>
            <DropdownMenuContent
                style={{position: 'fixed', left: contextMenu.position.x, top: contextMenu.position.y}}
                className={className}
            >
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
