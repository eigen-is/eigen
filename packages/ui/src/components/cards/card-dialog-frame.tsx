// The dialog a card opens into, on a board or beside a document: a top bar with the card's actions and the close
// button, over the card's body, which fills the rest and scrolls on its own, such as its thread or its edit form.
// While the body is the edit form the bar gives way to the dialog's own X, and Esc goes back to the card's view as the
// form's Cancel does. Once the form changed, Esc asks "Discard changes?" first, and so do the X and a click outside,
// which close the card. While the form saves, every close waits. Leaving the edit puts the focus back on the bar's Edit
// action, or on the dialog when the bar has none. Callers such as CardDialog fill in both.

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useDiscardChanges } from '../../hooks/use-discard-changes';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog';
import { Toolbar } from '../layout/toolbar/toolbar';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type CardDialogFrameProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Names the dialog for a screen reader. The body shows the title itself.
    title: string;
    actions?: ReactNode;
    // Set while the body is the edit form: whether it changed or saves, and its way back to the view.
    editing?: { changed: boolean; pending: boolean; onCancel: () => void };
    children: ReactNode;
};

export function CardDialogFrame({ open, onOpenChange, title, actions, editing, children }: CardDialogFrameProps) {
    const isEditing = !!editing;
    const changed = !!editing?.changed;
    const pending = !!editing?.pending;
    // Esc leaves the edit for the view, and every other close leaves the card.
    const backToView = useDiscardChanges({
        open: open && isEditing,
        changed,
        pending,
        onDiscard: () => editing?.onCancel(),
    });
    const close = useDiscardChanges({ open, changed, pending, onDiscard: () => onOpenChange(false) });

    const barRef = useRef<HTMLDivElement>(null);
    const wasEditing = useRef(isEditing);
    // The field that had the focus went with the form, and Radix would leave it on the dialog itself.
    useEffect(() => {
        if (wasEditing.current && !isEditing && open) {
            barRef.current?.querySelector<HTMLElement>('[aria-label="Edit"]')?.focus();
        }
        wasEditing.current = isEditing;
    }, [isEditing, open]);

    return (
        <>
            <Dialog open={open} onOpenChange={close.onOpenChange}>
                {/* The gutter takes the 24px every dialog pads with, so the edit form's footer runs exactly edge to
                    edge. */}
                <DialogContent
                    showCloseButton={isEditing}
                    className="flex flex-col gap-0 p-0 [--app-gutter-x:1.5rem]"
                    onFocus={(event) => {
                        backToView.onFocus(event);
                        close.onFocus(event);
                    }}
                    onEscapeKeyDown={(event) => {
                        // A field that keeps its own Esc, such as an open list, has taken it already.
                        if (!editing || event.defaultPrevented) return;
                        event.preventDefault();
                        backToView.onOpenChange(false);
                    }}
                >
                    <DialogTitle className="sr-only">{title}</DialogTitle>
                    <DialogDescription className="sr-only">Card details, attachments and replies.</DialogDescription>
                    {/* The same bar as a Column's toolbar, so the card reads the same in a dialog as in a pane. */}
                    {!editing && (
                        <div ref={barRef} className="app-gutter-x flex h-12 shrink-0 items-center">
                            <Toolbar>
                                <div />
                                <div className="flex items-center gap-1">
                                    {actions}
                                    <TooltipButton icon={X} tooltipText="Close" onClick={() => onOpenChange(false)} />
                                </div>
                            </Toolbar>
                        </div>
                    )}
                    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
                </DialogContent>
            </Dialog>
            {backToView.dialog}
            {close.dialog}
        </>
    );
}
