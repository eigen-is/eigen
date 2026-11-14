// The dialog that renames a column of a board or deletes it, after a confirmation. It writes to the board's
// Yjs document itself. A delete takes the column's cards with it, as one undo step.

import { getIdArray, getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';
import * as Y from 'yjs';

type ColumnSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    columnId: string;
    columnTitle: string;
    cardCount: number;
    yjsDoc: Y.Doc | null;
    // Seals the column delete as its own undo step.
    undoManager: Y.UndoManager | null;
};

export function ColumnSettingsDialog({
    isOpen,
    onClose,
    columnId,
    columnTitle,
    cardCount,
    yjsDoc,
    undoManager,
}: ColumnSettingsDialogProps) {
    const [title, setTitle] = useState(columnTitle);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = () => {
        if (!yjsDoc) return false;

        yjsDoc.transact(() => {
            const columnMap = getItemMapRoot(yjsDoc, 'columns').get(columnId);
            if (columnMap instanceof Y.Map) columnMap.set('title', title.trim());
        });
    };

    const handleDelete = () => {
        if (!yjsDoc) return;

        undoManager?.stopCapturing();
        yjsDoc.transact(() => {
            const columnsMap = getItemMapRoot(yjsDoc, 'columns');
            const tasksMap = yjsDoc.getMap('tasks');
            const columnOrderArray = getIdArrayRoot(yjsDoc, 'columnOrder');

            const columnMap = columnsMap.get(columnId);
            if (!columnMap) return;

            const taskIdsArray = getIdArray(columnMap, 'taskIds');
            if (taskIdsArray) {
                for (const taskId of taskIdsArray.toArray()) {
                    tasksMap.delete(taskId);
                }
            }

            const columnOrder = columnOrderArray.toArray();
            const columnIndex = columnOrder.indexOf(columnId);
            if (columnIndex !== -1) columnOrderArray.delete(columnIndex, 1);

            columnsMap.delete(columnId);
        });
        undoManager?.stopCapturing();

        onClose();
    };

    return (
        <>
            <FormDialog open={isOpen} onOpenChange={onClose} title="Column settings" size="sm">
                <FormDialogForm
                    canSubmit={title.trim() !== ''}
                    submitLabel="Save changes"
                    onSubmit={handleSubmit}
                    footerStart={
                        <Button variant="destructive" onClick={() => setIsDeleteDialogOpen(true)}>
                            Delete column
                        </Button>
                    }
                >
                    <Field>
                        <FieldLabel htmlFor="title">Title</FieldLabel>
                        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
                    </Field>
                </FormDialogForm>
            </FormDialog>

            <DeleteDialog
                open={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                title="Delete column"
                description={
                    cardCount > 0
                        ? `This will permanently delete the column and ${cardCount} ${cardCount === 1 ? 'card' : 'cards'} within it. You can undo this straight after, until you close the board.`
                        : 'This will permanently delete the column. You can undo this straight after, until you close the board.'
                }
                onDelete={handleDelete}
            />
        </>
    );
}
