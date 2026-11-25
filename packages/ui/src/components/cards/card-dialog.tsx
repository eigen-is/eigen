// The dialog a comment card opens into, on a board or beside a document: CardDetail's actions in the top bar over its
// body, and its edit form in place of the body while the card is edited. A save ends the edit once it lands, and the
// frame asks "Discard changes?" before a close drops a changed form. A deleted comment opens a small dialog with the
// deleted state instead, with nothing that acts.

import { useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { Dialog, DialogContent, DialogTitle } from '../dialog';
import type { CardDetailProps } from './card-detail';
import { CardDetail } from './card-detail';
import { CardDialogFrame } from './card-dialog-frame';

type CardDialogProps = Omit<CardDetailProps, 'children'> & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function CardDialog({ open, onOpenChange, ...detail }: CardDialogProps) {
    const { onEditingChange } = detail;
    // Whether the edit form holds a change, so the frame's Esc asks before it goes back to the view.
    const [editChanged, setEditChanged] = useState(false);
    // A save leaves the edit for the view once it lands.
    const edit = useDialogPending({ open, onOpenChange: onEditingChange });

    const handleOpenChange = (next: boolean) => {
        if (!next) onEditingChange(false);
        onOpenChange(next);
    };

    return (
        <CardDetail {...detail}>
            {(parts) => {
                if (!parts) return null;
                const { title, deleted, actions, body, editForm } = parts;
                return deleted ? (
                    <Dialog open={open} onOpenChange={handleOpenChange}>
                        <DialogContent size="sm" aria-describedby={undefined}>
                            <DialogTitle className="sr-only">Deleted comment</DialogTitle>
                            <div className="pr-8">{body}</div>
                        </DialogContent>
                    </Dialog>
                ) : (
                    <CardDialogFrame
                        open={open}
                        onOpenChange={handleOpenChange}
                        title={title}
                        actions={actions}
                        editing={
                            editForm
                                ? {
                                      changed: editChanged,
                                      pending: edit.pending,
                                      onCancel: () => onEditingChange(false),
                                  }
                                : undefined
                        }
                    >
                        {editForm ? (
                            // The form scrolls inside on short viewports, and the thread hides while it is open.
                            <div className="app-gutter-x flex min-h-0 flex-1 flex-col">
                                {editForm({ pending: edit.pending, run: edit.run, onChangedChange: setEditChanged })}
                            </div>
                        ) : (
                            body
                        )}
                    </CardDialogFrame>
                );
            }}
        </CardDetail>
    );
}
