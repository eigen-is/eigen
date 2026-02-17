import {ReactNode} from 'react';
import {DropdownMenu, DropdownMenuTrigger} from '@workspace/ui/components/dropdown-menu';

interface ContextMenuAnchorProps {
    isOpen: boolean;
    position: {x: number; y: number};
    onClose: () => void;
    children: ReactNode;
}

export function ContextMenuAnchor({isOpen, position, onClose, children}: ContextMenuAnchorProps) {
    return (
        <DropdownMenu open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DropdownMenuTrigger className="hidden"/>
            {children}
        </DropdownMenu>
    );
}
