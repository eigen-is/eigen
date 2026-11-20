// The dialog a sticky or comment card opens into: a top bar with the card's actions and the close button, over the
// card's body, which fills the rest and scrolls on its own, such as its thread or its edit form. Callers such as
// CardDialog fill in both.

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog';
import { Toolbar } from '../layout/toolbar/toolbar';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type NoteCardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Names the dialog for a screen reader. The body shows the title itself.
    title: string;
    actions?: ReactNode;
    children: ReactNode;
};

export function NoteCardDialog({ open, onOpenChange, title, actions, children }: NoteCardDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent showCloseButton={false} className="flex flex-col gap-0 p-0">
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <DialogDescription className="sr-only">Card details, attachments and replies.</DialogDescription>
                {/* The same bar as a Column's toolbar, so the card reads the same in a dialog as in a pane. */}
                <div className="app-gutter-x flex h-12 shrink-0 items-center">
                    <Toolbar>
                        <div />
                        <div className="flex items-center gap-1">
                            {actions}
                            <TooltipButton icon={X} tooltipText="Close" onClick={() => onOpenChange(false)} />
                        </div>
                    </Toolbar>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">{children}</div>
            </DialogContent>
        </Dialog>
    );
}
